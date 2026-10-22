import { api, esc, icon, toast, toastError, navigate, options, richEditor, relTime, emptyState, isManager, confirmDialog, promptDialog, userName, debounce } from '../core.js';
import { setCrumbs } from '../app.js';

export async function render(el, [id], query) {
  if (id) return editor(el, id);
  setCrumbs([{ label: 'Base de conocimiento' }]);
  const [cats, arts] = await Promise.all([api('/kb/categories'), api(`/kb/articles?${new URLSearchParams({ q: query.q || '', category: query.category || '' })}`)]);
  el.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Base de conocimiento</h1><p class="muted">Artículos para el portal de soporte y para el equipo.</p></div>
      <div class="row gap"><a class="btn" href="/portal#/kb" target="_blank" rel="noopener">${icon('globe', 15)} Ver en el portal</a><a class="btn primary" href="#/kb/new">${icon('plus', 15)} Nuevo artículo</a></div></div>
    <div class="kb-layout">
      <aside class="card kb-cats">
        <div class="sec-head"><h4>Categorías</h4>${isManager() ? `<button class="icon-btn sm" data-act="newcat" title="Nueva categoría">${icon('plus', 14)}</button>` : ''}</div>
        <a href="#/kb" class="${!query.category ? 'on' : ''}">Todas <b>${arts.length}</b></a>
        ${cats.map((c) => `<div class="kb-cat-row"><a href="#/kb?category=${c.id}" class="${String(c.id) === query.category ? 'on' : ''}">${esc(c.name)} ${c.visibility === 'internal' ? `<small title="Solo agentes">${icon('shield', 11)}</small>` : ''}</a>
          ${isManager() ? `<button class="icon-btn sm" data-editcat="${c.id}" title="Editar">${icon('edit', 12)}</button>` : ''}</div>`).join('')}
      </aside>
      <section>
        <div class="toolbar flat"><div class="searchbox">${icon('search', 15)}<input data-q placeholder="Buscar artículos" value="${esc(query.q || '')}"></div></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Título</th><th>Categoría</th><th>Estado</th><th>Vistas</th><th>Actualizado</th></tr></thead>
        <tbody>${arts.map((a) => `<tr class="clickable" data-id="${a.id}"><td><b>${esc(a.title)}</b></td><td>${esc(cats.find((c) => c.id === a.category_id)?.name || '—')}</td>
          <td>${a.status === 'published' ? '<span class="badge" style="--c:#059669">Publicado</span>' : '<span class="badge" style="--c:#64748b">Borrador</span>'}</td><td>${a.views}</td><td class="muted">${relTime(a.updated_at)}</td></tr>`).join('') || `<tr><td colspan="5">${emptyState('Sin artículos', 'Escribí guías para que los usuarios se resuelvan solos.', 'book')}</td></tr>`}</tbody></table></div>
      </section>
    </div></div>`;
  el.querySelector('[data-q]').addEventListener('input', debounce((e) => navigate(`#/kb?${new URLSearchParams({ q: e.target.value, category: query.category || '' })}`), 400));
  el.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) return navigate(`#/kb/${tr.dataset.id}`);
    const ec = e.target.closest('[data-editcat]');
    if (ec) return editCategory(cats.find((c) => c.id === Number(ec.dataset.editcat)));
    if (e.target.closest('[data-act=newcat]')) editCategory(null);
  });
}

async function editCategory(c) {
  const name = await promptDialog('Nombre de la categoría', { value: c?.name || '', title: c ? 'Editar categoría' : 'Nueva categoría' });
  if (name === null) return;
  try {
    if (c && !name) {
      if (await confirmDialog('¿Eliminar la categoría? Los artículos quedan sin categoría.', { danger: true, okText: 'Eliminar' })) await api(`/kb/categories/${c.id}`, { method: 'DELETE' });
    } else if (c) await api(`/kb/categories/${c.id}`, { method: 'PATCH', body: { name } });
    else await api('/kb/categories', { method: 'POST', body: { name, visibility: 'public' } });
    navigate('#/kb');
  } catch (e) { toastError(e); }
}

async function editor(el, id) {
  const isNew = id === 'new';
  const [cats, art] = await Promise.all([api('/kb/categories'), isNew ? Promise.resolve({ title: '', body_html: '', status: 'draft', category_id: null }) : api(`/kb/articles/${id}`)]);
  setCrumbs([{ label: 'Base de conocimiento', href: '#/kb' }, { label: isNew ? 'Nuevo artículo' : art.title }]);
  el.innerHTML = `<div class="page narrow">
    <div class="page-head"><div><h1>${isNew ? 'Nuevo artículo' : 'Editar artículo'}</h1>${!isNew ? `<p class="muted small">Autor: ${esc(userName(art.author_id) || '—')} · ${art.views} vistas</p>` : ''}</div>
      <div class="row gap">${!isNew && isManager() ? `<button class="btn danger ghost" data-act="delete">${icon('trash', 15)} Eliminar</button>` : ''}<a class="btn" href="#/kb">Cancelar</a><button class="btn primary" data-act="save">Guardar</button></div></div>
    <div class="card">
      <label class="field"><span>Título</span><input class="input big" name="title" value="${esc(art.title)}"></label>
      <div class="grid2">
        <label class="field"><span>Categoría</span><select class="input" name="category_id">${options(cats, art.category_id, { empty: '—' })}</select></label>
        <label class="field"><span>Estado</span><select class="input" name="status"><option value="draft" ${art.status === 'draft' ? 'selected' : ''}>Borrador</option><option value="published" ${art.status === 'published' ? 'selected' : ''}>Publicado</option></select></label>
      </div>
      <div class="field"><span>Contenido</span><div class="editor"></div></div>
    </div></div>`;
  const ed = richEditor(el.querySelector('.editor'), { value: art.body_html, attachments: false, minHeight: 320, placeholder: 'Paso a paso, capturas (podés pegar imágenes como enlaces), preguntas frecuentes…' });
  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'save') {
      const body = { title: el.querySelector('[name=title]').value.trim(), category_id: Number(el.querySelector('[name=category_id]').value) || null, status: el.querySelector('[name=status]').value, body_html: ed.getHTML() };
      try {
        const saved = isNew ? await api('/kb/articles', { method: 'POST', body }) : await api(`/kb/articles/${id}`, { method: 'PATCH', body });
        toast('Artículo guardado');
        if (isNew) navigate(`#/kb/${saved.id}`);
      } catch (er) { toastError(er); }
    }
    if (a.dataset.act === 'delete') {
      if (!(await confirmDialog('¿Eliminar el artículo?', { danger: true, okText: 'Eliminar' }))) return;
      await api(`/kb/articles/${id}`, { method: 'DELETE' }).catch(toastError);
      navigate('#/kb');
    }
  });
}
