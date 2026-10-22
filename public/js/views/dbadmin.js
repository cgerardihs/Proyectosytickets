// Explorador de la base de datos (solo superadmin): tablas, búsqueda, edición y borrado con auditoría.
import { api, esc, icon, toast, toastError, modal, fmtNum, fmtDateTime, debounce } from '../core.js';

const MODE = { edit: 'Se puede modificar', delete: 'Solo borrar', read: 'Solo lectura' };
const MODE_ICON = { edit: 'edit', delete: 'trash', read: 'eye' };
const load = () => { try { return JSON.parse(sessionStorage.getItem('dbx') || '{}'); } catch { return {}; } };
const save = (s) => { try { sessionStorage.setItem('dbx', JSON.stringify(s)); } catch { /* */ } };

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function cellText(v, c) {
  if (v === null || v === undefined) return '<span class="dbx-null">null</span>';
  if (c.blob) return `<span class="muted">archivo · ${fmtNum(Number(v) / 1024, 1)} KB</span>`;
  if (c.kind === 'bool') return v ? '<span class="dbx-true">true</span>' : '<span class="dbx-false">false</span>';
  if (c.kind === 'ts' && TS.test(String(v))) return esc(fmtDateTime(v));
  if (c.kind === 'date') return esc(String(v).slice(0, 10));
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return esc(s.length > 120 ? `${s.slice(0, 120)}…` : s);
}

export async function dbAdmin(body) {
  // El modo edición nunca queda prendido entre visitas
  const st = { table: '', q: '', col: '', val: '', isnull: false, sort: '', dir: 'asc', page: 1, size: 50, filter: '', ...load(), edit: false, sel: new Set() };
  let tables = [];
  let meta = null;
  let data = null;

  body.innerHTML = `<div class="card dbx-warn"><div class="sec-head"><h3>${icon('layers', 16)} Base de datos</h3><span class="badge super-badge">Solo superadmin</span></div>
    <p class="muted small" style="margin:0">Acceso directo a las tablas. Los cambios no pasan por las reglas de la aplicación (avisos, SLA, automatizaciones), así que usalo para corregir datos puntuales. Cada modificación y cada borrado queda en la auditoría con el valor anterior. Antes de un cambio grande, <a href="#/settings/superadmin">descargá un respaldo</a>.</p></div>
    <div class="dbx">
      <aside class="card dbx-tables"><div class="searchbox">${icon('search', 14)}<input data-tfilter placeholder="Buscar tabla" value="${esc(st.filter)}"></div><div data-tlist class="dbx-tlist"><div class="loading"><span class="spinner"></span></div></div></aside>
      <section class="card dbx-main" data-main><p class="muted">Elegí una tabla.</p></section>
    </div>`;
  const tlist = body.querySelector('[data-tlist]');
  const main = body.querySelector('[data-main]');

  const drawTables = () => {
    const f = st.filter.toLowerCase();
    tlist.innerHTML = tables.filter((t) => !f || t.name.includes(f)).map((t) => `<button type="button" class="dbx-t ${t.name === st.table ? 'on' : ''}" data-table="${esc(t.name)}" title="${MODE[t.mode]}">
      <span class="dbx-mode m-${t.mode}">${icon(MODE_ICON[t.mode], 11)}</span><span class="ellip">${esc(t.name)}</span><small>${fmtNum(t.rows)}${t.capped ? '+' : ''}</small></button>`).join('') || '<p class="muted small">Sin tablas.</p>';
  };

  async function refreshTables() {
    tables = (await api('/super/db/tables')).tables;
    drawTables();
  }

  async function openTable(name, { keepFilters = false } = {}) {
    if (!keepFilters || name !== st.table) Object.assign(st, { q: '', col: '', val: '', isnull: false, sort: '', dir: 'asc', page: 1 });
    st.table = name;
    st.sel = new Set();
    drawTables();
    await fetchRows();
  }

  async function fetchRows() {
    if (!st.table) return;
    st.sel = new Set(); // la selección es de lo que se ve: cambiar de página, filtro u orden la limpia
    save({ ...st, sel: undefined });
    main.innerHTML = '<div class="loading"><span class="spinner"></span> Cargando…</div>';
    const params = new URLSearchParams({ page: st.page, size: st.size, dir: st.dir });
    for (const k of ['q', 'sort', 'col']) if (st[k]) params.set(k, st[k]);
    if (st.col) { if (st.isnull) params.set('isnull', '1'); else params.set('val', st.val); }
    try {
      data = await api(`/super/db/tables/${encodeURIComponent(st.table)}/rows?${params}`);
      meta = data.meta;
      drawMain();
    } catch (er) {
      main.innerHTML = `<div class="callout warn">${icon('alert', 16)} ${esc(er.message)}</div>`;
      if (er.status === 404) { st.table = ''; save({ ...st, sel: undefined }); refreshTables(); }
    }
  }

  const cols = () => meta.columns.filter((c) => !c.secret);
  const pkOf = (row) => Object.fromEntries(meta.pk.map((k) => [k, row[k]]));
  const pkKey = (row) => JSON.stringify(pkOf(row));
  const canDelete = () => st.edit && ['edit', 'delete'].includes(meta.mode);
  const canEdit = () => st.edit && meta.mode === 'edit';

  function drawMain() {
    const c = cols();
    const secret = meta.columns.filter((x) => x.secret).map((x) => x.name);
    const pages = Math.max(1, Math.ceil(data.total / data.size));
    const cascade = meta.referencedBy.filter((r) => r.onDelete === 'cascade');
    const allSel = data.rows.length && data.rows.every((r) => st.sel.has(pkKey(r)));
    main.innerHTML = `<div class="dbx-head">
        <div><h3 class="dbx-title">${esc(meta.name)} <span class="dbx-mode m-${meta.mode}">${icon(MODE_ICON[meta.mode], 11)} ${MODE[meta.mode]}</span></h3>
          <p class="muted small">${fmtNum(data.total)} registro(s)${meta.pk.length ? ` · clave: ${esc(meta.pk.join(' + '))}` : ' · sin clave primaria (solo lectura)'}${secret.length ? ` · ocultas por seguridad: ${esc(secret.join(', '))}` : ''}</p></div>
        <span class="grow"></span>
        ${meta.mode !== 'read' ? `<label class="dbx-toggle ${st.edit ? 'on' : ''}"><input type="checkbox" data-editmode ${st.edit ? 'checked' : ''}> Modo edición</label>` : ''}
        <button class="icon-btn" data-reload title="Actualizar">${icon('refresh', 16)}</button>
      </div>
      <div class="dbx-tools">
        <div class="searchbox">${icon('search', 14)}<input data-q placeholder="Buscar en todas las columnas" value="${esc(st.q)}"></div>
        <select class="input sm" data-col><option value="">Filtrar por columna…</option>${c.filter((x) => !x.blob).map((x) => `<option value="${esc(x.name)}" ${x.name === st.col ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        ${st.col ? `<input class="input sm" data-val placeholder="valor exacto" value="${esc(st.val)}" ${st.isnull ? 'disabled' : ''}><label class="check small"><input type="checkbox" data-isnull ${st.isnull ? 'checked' : ''}> es null</label><button class="btn sm" data-apply>Filtrar</button><button class="link-btn" data-clearf>Quitar filtro</button>` : ''}
        <span class="grow"></span>
        ${canDelete() ? `<button class="btn sm danger" data-del ${st.sel.size ? '' : 'disabled'}>${icon('trash', 13)} Borrar ${st.sel.size || ''} seleccionado(s)</button>` : ''}
      </div>
      ${st.edit && cascade.length ? `<p class="dbx-cascade">${icon('alert', 13)} Al borrar en esta tabla también se borran, en cascada, sus registros relacionados en: <b>${esc([...new Set(cascade.map((r) => r.table))].join(', '))}</b>.</p>` : ''}
      <div class="table-wrap dbx-grid"><table class="tbl compact"><thead><tr>
        ${canDelete() ? `<th class="dbx-chk"><input type="checkbox" data-all ${allSel ? 'checked' : ''} aria-label="Seleccionar todo"></th>` : ''}
        ${c.map((x) => `<th class="sortable" data-sort="${esc(x.name)}" title="${esc(`${x.type}${x.nullable ? '' : ' · obligatorio'}${x.fk ? ` · → ${x.fk.table}.${x.fk.column}` : ''}`)}">${x.pk ? `${icon('flag', 10)} ` : ''}${esc(x.name)}${st.sort === x.name ? (st.dir === 'asc' ? ' ▲' : ' ▼') : ''}<small>${esc(x.kind)}</small></th>`).join('')}
      </tr></thead><tbody>
      ${data.rows.map((r) => `<tr class="${canEdit() ? 'clickable' : ''}" data-pk="${esc(pkKey(r))}">
        ${canDelete() ? `<td class="dbx-chk"><input type="checkbox" data-sel ${st.sel.has(pkKey(r)) ? 'checked' : ''} aria-label="Seleccionar"></td>` : ''}
        ${c.map((x) => `<td>${x.fk && r[x.name] !== null && r[x.name] !== undefined ? `<button type="button" class="dbx-fk" data-fk-table="${esc(x.fk.table)}" data-fk-col="${esc(x.fk.column)}" data-fk-val="${esc(String(r[x.name]))}" title="Ver en ${esc(x.fk.table)}">${cellText(r[x.name], x)}</button>` : cellText(r[x.name], x)}</td>`).join('')}
      </tr>`).join('') || `<tr><td colspan="${c.length + 1}" class="muted">Sin registros${st.q || st.col ? ' con este filtro' : ''}.</td></tr>`}
      </tbody></table></div>
      <div class="dbx-pager"><span class="muted small">Página ${data.page} de ${pages}${data.rows.length ? ` · textos largos recortados a ${data.truncatedAt} caracteres en la grilla` : ''}</span><span class="grow"></span>
        <select class="input sm" data-size>${[25, 50, 100, 200].map((n) => `<option ${n === data.size ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <button class="btn sm" data-page="-1" ${data.page <= 1 ? 'disabled' : ''}>${icon('left', 14)}</button><button class="btn sm" data-page="1" ${data.page >= pages ? 'disabled' : ''}>${icon('right', 14)}</button></div>
      ${st.edit ? '' : `<p class="hint">${meta.mode === 'read' ? 'Esta tabla es de solo lectura.' : 'Activá <b>Modo edición</b> para modificar o borrar registros. Tocá un valor con flecha para ir al registro relacionado.'}</p>`}`;
  }

  // ---------- Edición ----------
  async function editRow(pkStr) {
    const pk = JSON.parse(pkStr);
    let row;
    try { row = (await api(`/super/db/tables/${encodeURIComponent(meta.name)}/row?pk=${encodeURIComponent(pkStr)}`)).row; } catch (er) { return toastError(er); }
    const fields = cols();
    const input = (c) => {
      const v = row[c.name];
      const id = `dbf-${c.name}`;
      const lock = c.pk || c.blob;
      const nullBox = c.nullable && !lock ? `<label class="check small dbx-nullbox"><input type="checkbox" data-null="${esc(c.name)}" ${v === null ? 'checked' : ''}> null</label>` : '';
      let ctl;
      if (lock) ctl = `<div class="dbx-ro">${cellText(v, c)}</div>`;
      else if (c.kind === 'bool') ctl = `<label class="check"><input type="checkbox" id="${id}" data-f="${esc(c.name)}" ${v ? 'checked' : ''}> ${v ? 'true' : 'false'}</label>`;
      else if (c.kind === 'int' || c.kind === 'num') ctl = `<input class="input" id="${id}" data-f="${esc(c.name)}" inputmode="decimal" value="${v === null ? '' : esc(String(v))}">`;
      else if (c.kind === 'date') ctl = `<input class="input" type="date" id="${id}" data-f="${esc(c.name)}" value="${v ? esc(String(v).slice(0, 10)) : ''}">`;
      else if (c.kind === 'ts') ctl = `<input class="input mono" id="${id}" data-f="${esc(c.name)}" value="${v ? esc(new Date(v).toISOString()) : ''}" placeholder="AAAA-MM-DDThh:mm:ssZ">`;
      else if (c.kind === 'json' || c.kind === 'array') ctl = `<textarea class="input mono" rows="${Math.min(10, Math.max(2, JSON.stringify(v ?? null, null, 2).split('\n').length))}" id="${id}" data-f="${esc(c.name)}">${v === null ? '' : esc(JSON.stringify(v, null, 2))}</textarea>`;
      else {
        const s = v === null ? '' : String(v);
        ctl = s.length > 80 || s.includes('\n') ? `<textarea class="input" rows="${Math.min(12, Math.max(3, Math.ceil(s.length / 90)))}" id="${id}" data-f="${esc(c.name)}">\n${esc(s)}</textarea>` : `<input class="input" id="${id}" data-f="${esc(c.name)}" value="${esc(s)}">`;
      }
      return `<div class="field dbx-field"><span><label for="${id}"><b>${esc(c.name)}</b></label> <small class="muted">${esc(c.type)}${c.nullable ? '' : ' · obligatorio'}${c.pk ? ' · clave' : ''}${c.fk ? ` · → ${esc(c.fk.table)}` : ''}</small>${nullBox}</span>${ctl}</div>`;
    };
    const md = modal({
      title: `${meta.name} · ${meta.pk.map((k) => `${k} ${pk[k]}`).join(', ')}`,
      wide: true,
      body: `<div class="dbx-form">${fields.map(input).join('')}</div><p class="hint">Los cambios se guardan tal cual en la base, sin pasar por las reglas de la aplicación. Queda registrado en la auditoría.</p>`,
      footer: `<span class="grow"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Revisar cambios</button>`,
    });
    md.el.addEventListener('change', (e) => {
      const nb = e.target.closest('[data-null]');
      if (nb) { const f = md.el.querySelector(`[data-f="${CSS.escape(nb.dataset.null)}"]`); if (f) f.disabled = nb.checked; }
    });
    md.el.querySelectorAll('[data-null]:checked').forEach((nb) => { const f = md.el.querySelector(`[data-f="${CSS.escape(nb.dataset.null)}"]`); if (f) f.disabled = true; });
    const read = () => {
      const values = {};
      for (const c of fields) {
        if (c.pk || c.blob) continue;
        const el = md.el.querySelector(`[data-f="${CSS.escape(c.name)}"]`);
        if (!el) continue;
        const isNull = md.el.querySelector(`[data-null="${CSS.escape(c.name)}"]`)?.checked;
        let v;
        if (isNull) v = null;
        else if (c.kind === 'bool') v = el.checked;
        else if (c.kind === 'json' || c.kind === 'array') {
          const t = el.value.trim();
          if (!t) v = c.kind === 'array' ? [] : null;
          else {
            try { v = JSON.parse(t); } catch { throw new Error(`«${c.name}» no es JSON válido`); }
            if (c.kind === 'array' && !Array.isArray(v)) throw new Error(`«${c.name}» tiene que ser una lista: ["a", "b"]`);
          }
        } else if (c.kind === 'int' || c.kind === 'num') v = el.value.trim() === '' ? (c.nullable ? null : '') : el.value.trim();
        else if (c.kind === 'date' || c.kind === 'ts') v = el.value.trim() || (c.nullable ? null : '');
        else v = el.value;
        const old = row[c.name];
        // Los textarea cambian \r\n por \n: eso no cuenta como cambio
        const norm = (x) => (x === null || x === undefined ? null : c.kind === 'ts' ? new Date(x).getTime() : c.kind === 'date' ? String(x).slice(0, 10) : c.kind === 'int' || c.kind === 'num' ? String(x).trim().replace(',', '.') : typeof x === 'object' ? JSON.stringify(x) : String(x).replace(/\r\n?/g, '\n'));
        if (norm(v) !== norm(old)) values[c.name] = v;
      }
      return values;
    };
    md.el.querySelector('[data-ok]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      let values;
      try { values = read(); } catch (er) { return toast(er.message, 'error'); }
      const keys = Object.keys(values);
      if (!keys.length) return toast('No hay cambios');
      const show = (x) => (x === null ? 'null' : typeof x === 'object' ? JSON.stringify(x) : String(x));
      const cut = (s) => (s.length > 160 ? `${s.slice(0, 160)}…` : s);
      const ok = await new Promise((resolve) => {
        let done = false;
        const cm = modal({
          title: 'Confirmar cambios',
          body: `<p class="small">Vas a modificar <b>${keys.length}</b> campo(s) de <b>${esc(meta.name)}</b>:</p><table class="tbl compact dbx-diff"><thead><tr><th>Campo</th><th>Antes</th><th>Después</th></tr></thead><tbody>
            ${keys.map((k) => `<tr><td><b>${esc(k)}</b></td><td><s>${esc(cut(show(row[k])))}</s></td><td>${esc(cut(show(values[k])))}</td></tr>`).join('')}</tbody></table>`,
          footer: '<button class="btn" data-close>Volver</button><button class="btn primary" data-yes>Guardar en la base</button>',
          onClose: () => { if (!done) resolve(false); },
        });
        cm.el.querySelector('[data-yes]').addEventListener('click', () => { done = true; cm.close(); resolve(true); });
      });
      if (!ok) return;
      btn.disabled = true;
      try {
        const r = await api(`/super/db/tables/${encodeURIComponent(meta.name)}/row`, { method: 'PATCH', body: { pk, values } });
        md.close();
        toast(r.changed.length ? `Guardado: ${r.changed.join(', ')}` : 'No cambió nada');
        await fetchRows();
      } catch (er) { toastError(er); btn.disabled = false; }
    });
  }

  async function deleteSelected() {
    const pks = [...st.sel].map((k) => JSON.parse(k));
    if (!pks.length) return;
    const cascade = [...new Set(meta.referencedBy.filter((r) => r.onDelete === 'cascade').map((r) => r.table))];
    const ok = await new Promise((resolve) => {
      let done = false;
      const cm = modal({
        title: `Borrar ${pks.length} registro(s) de ${meta.name}`,
        body: `<div class="callout warn">${icon('alert', 16)} <div>Se borran definitivamente. ${cascade.length ? `También se borran en cascada sus registros relacionados en <b>${esc(cascade.join(', '))}</b>. ` : ''}Una copia de lo borrado (sin los relacionados y con los textos muy largos recortados) queda en la auditoría.</div></div>
          <label class="field"><span>Para confirmar, escribí <b>BORRAR</b></span><input class="input" data-confirm autocomplete="off"></label>`,
        footer: '<button class="btn" data-close>Cancelar</button><button class="btn danger" data-yes disabled>Borrar</button>',
        onClose: () => { if (!done) resolve(null); },
      });
      const inp = cm.el.querySelector('[data-confirm]');
      const yes = cm.el.querySelector('[data-yes]');
      inp.addEventListener('input', () => { yes.disabled = inp.value.trim() !== 'BORRAR'; });
      yes.addEventListener('click', () => { done = true; const v = inp.value.trim(); cm.close(); resolve(v); });
      setTimeout(() => inp.focus(), 40);
    });
    if (!ok) return;
    try {
      const r = await api(`/super/db/tables/${encodeURIComponent(meta.name)}/delete`, { method: 'POST', body: { pks, confirm: ok } });
      toast(`Borrados: ${r.deleted}`);
      st.sel = new Set();
      await Promise.all([fetchRows(), refreshTables()]);
    } catch (er) { toastError(er); }
  }

  // ---------- Eventos ----------
  body.addEventListener('click', (e) => {
    const t = e.target;
    const tb = t.closest('[data-table]');
    if (tb) return openTable(tb.dataset.table);
    if (!meta) return;
    const fk = t.closest('[data-fk-table]');
    if (fk) {
      e.stopPropagation();
      Object.assign(st, { table: fk.dataset.fkTable, q: '', sort: '', dir: 'asc', col: fk.dataset.fkCol, val: fk.dataset.fkVal, isnull: false, page: 1 });
      st.sel = new Set();
      drawTables();
      fetchRows();
      return;
    }
    const s = t.closest('[data-sort]');
    if (s) { st.dir = st.sort === s.dataset.sort && st.dir === 'asc' ? 'desc' : 'asc'; st.sort = s.dataset.sort; st.page = 1; fetchRows(); return; }
    const pg = t.closest('[data-page]');
    if (pg) { st.page += Number(pg.dataset.page); fetchRows(); return; }
    if (t.closest('[data-reload]')) { fetchRows(); refreshTables(); return; }
    if (t.closest('[data-apply]')) { st.val = main.querySelector('[data-val]')?.value || ''; st.page = 1; fetchRows(); return; }
    if (t.closest('[data-clearf]')) { Object.assign(st, { col: '', val: '', isnull: false, page: 1 }); fetchRows(); return; }
    if (t.closest('[data-del]')) { deleteSelected(); return; }
    if (t.closest('[data-sel], [data-all], .dbx-chk')) return;
    const tr = t.closest('tr[data-pk]');
    if (tr && canEdit()) editRow(tr.dataset.pk);
  });
  body.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-editmode]')) { st.edit = t.checked; st.sel = new Set(); drawMain(); save({ ...st, sel: undefined }); return; }
    if (t.matches('[data-col]')) { st.col = t.value; st.val = ''; st.isnull = false; if (!st.col) { st.page = 1; fetchRows(); } else drawMain(); return; }
    if (t.matches('[data-isnull]')) { st.isnull = t.checked; drawMain(); return; }
    if (t.matches('[data-size]')) { st.size = Number(t.value); st.page = 1; fetchRows(); return; }
    if (t.matches('[data-sel]')) { const k = t.closest('tr').dataset.pk; if (t.checked) st.sel.add(k); else st.sel.delete(k); drawMain(); return; }
    if (t.matches('[data-all]')) { for (const r of data.rows) { if (t.checked) st.sel.add(pkKey(r)); else st.sel.delete(pkKey(r)); } drawMain(); }
  });
  body.addEventListener('input', debounce((e) => {
    if (e.target.matches('[data-tfilter]')) { st.filter = e.target.value.trim(); drawTables(); save({ ...st, sel: undefined }); }
    if (e.target.matches('[data-q]')) {
      st.q = e.target.value.trim(); st.page = 1;
      fetchRows().then(() => { const i = main.querySelector('[data-q]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
    }
  }, 300));
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-val]')) { st.val = e.target.value; st.page = 1; fetchRows(); } });

  await refreshTables();
  if (st.table && tables.some((t) => t.name === st.table)) await openTable(st.table, { keepFilters: true });
}
