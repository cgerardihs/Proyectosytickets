import { state, api, esc, icon, avatar, toast, toastError, richEditor, confirmDialog, relTime, navigate, ROLE_LABEL } from '../core.js';
import { setCrumbs, refreshMeta } from '../app.js';
import { passkeysSupported, createPasskey } from '../webauthn.js';

const METHOD = { password: 'Clave', passkey: 'Passkey', microsoft: 'Microsoft', superadmin: 'Superadmin' };

function device(ua) {
  const s = String(ua || '');
  const os = /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'macOS' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Linux/.test(s) ? 'Linux' : 'Otro';
  const br = /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'Navegador';
  return `${br} en ${os}`;
}

export async function render(el) {
  setCrumbs([{ label: 'Mi perfil' }]);
  const me = state.me;
  const [keys, sessions] = await Promise.all([state.passkeys ? api('/me/passkeys').catch(() => []) : [], api('/me/sessions').catch(() => [])]);
  el.innerHTML = `<div class="page narrow">
    <div class="page-head"><div class="row gap">${avatar(me, 48, false)}<div><h1>${esc(me.name)}</h1><p class="muted">${esc(me.email)} · ${ROLE_LABEL[me.role]}</p></div></div></div>
    <form class="card" data-form="profile">
      <h3>Datos</h3>
      <label class="field"><span>Nombre</span><input class="input" name="name" value="${esc(me.name)}" maxlength="120"></label>
      <div class="field"><span>Firma para las respuestas por correo</span><div class="sig"></div></div>
      <button class="btn primary">Guardar</button>
    </form>

    ${state.passkeys ? `<section class="card">
      <div class="sec-head"><h3>${icon('shield', 16)} Passkeys</h3>${passkeysSupported() ? '<button type="button" class="btn sm primary" data-act="add-passkey">Agregar passkey</button>' : ''}</div>
      <p class="hint" style="margin-top:-4px">Ingresá con la huella, el rostro o el PIN de tu equipo o celular (Windows Hello, Touch ID, Android). No se puede robar con un correo falso y no hay clave que recordar.</p>
      ${keys.length ? `<ul class="mini-list">${keys.map((k) => `<li class="row"><span>${icon('shield', 13)} <b>${esc(k.name)}</b> <small class="muted">${k.backed_up ? 'sincronizada' : 'en este dispositivo'} · creada ${relTime(k.created_at)}${k.last_used_at ? ` · usada ${relTime(k.last_used_at)}` : ''}</small></span><button type="button" class="icon-btn sm" data-delkey="${esc(k.id)}" title="Quitar">${icon('x', 12)}</button></li>`).join('')}</ul>`
    : `<p class="muted small">${passkeysSupported() ? 'Todavía no registraste ninguna.' : 'Este navegador no admite passkeys.'}</p>`}
    </section>` : ''}

    ${me.role === 'superadmin' ? '<div class="card"><h3>Clave</h3><p class="muted">La clave del superadmin se define en Vercel con la variable <code>SUPERADMIN_PASSWORD</code>. Para cambiarla, actualizala allá y volvé a desplegar.</p></div>' : `<form class="card" data-form="password">
      <h3>Cambiar clave</h3>
      <label class="field"><span>Clave actual</span><input class="input" type="password" name="current" autocomplete="current-password"></label>
      <label class="field"><span>Clave nueva (mínimo 10 caracteres)</span><input class="input" type="password" name="password" autocomplete="new-password" minlength="10" maxlength="128"></label>
      <p class="hint">Usá una frase fácil de recordar para vos y difícil de adivinar. Al cambiarla se cierran tus otras sesiones.</p>
      <button class="btn">Actualizar clave</button>
    </form>`}

    <section class="card">
      <div class="sec-head"><h3>${icon('layers', 16)} Sesiones abiertas</h3>${sessions.length > 1 ? '<button type="button" class="btn sm" data-act="revoke-others">Cerrar las otras sesiones</button>' : ''}</div>
      <ul class="mini-list">${sessions.map((x, i) => `<li><span><b>${esc(device(x.user_agent))}</b>${x.current ? ' <span class="badge" style="--c:#059669">Esta sesión</span>' : ''}</span>
        <small>${esc(METHOD[x.method] || x.method)} · IP ${esc(x.ip)} · última actividad ${relTime(x.last_seen_at)}</small></li>`).join('') || '<li class="muted">Sin sesiones.</li>'}</ul>
    </section></div>`;
  const sig = richEditor(el.querySelector('.sig'), { value: me.signature_html || '', attachments: false, minHeight: 80, placeholder: 'Saludos,\nNombre · Área de IT' });

  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      if (f.dataset.form === 'profile') {
        await api('/me', { method: 'PATCH', body: { name: f.name.value, signature_html: sig.getHTML() } });
        await refreshMeta();
        state.me.signature_html = sig.getHTML();
        toast('Perfil actualizado');
      } else {
        await api('/me/password', { method: 'POST', body: { current: f.current.value, password: f.password.value } });
        f.reset();
        toast('Clave actualizada. Se cerraron tus otras sesiones.');
        navigate('#/profile');
      }
    } catch (er) { toastError(er); }
  });

  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act=add-passkey]')) {
      try {
        const { challengeId, options } = await api('/auth/passkeys/register/options', { method: 'POST', body: {} });
        const credential = await createPasskey(options);
        const name = `${device(navigator.userAgent)}`;
        await api('/auth/passkeys/register/verify', { method: 'POST', body: { challengeId, credential, name } });
        toast('Passkey agregada. La próxima vez podés ingresar con ella.');
        navigate('#/profile');
      } catch (er) {
        if (er?.name === 'NotAllowedError') return toast('Se canceló el registro de la passkey', 'error');
        if (er?.name === 'InvalidStateError') return toast('Este dispositivo ya tiene una passkey registrada', 'error');
        toastError(er);
      }
    }
    const del = e.target.closest('[data-delkey]');
    if (del) {
      if (!(await confirmDialog('Se quita la passkey. Vas a poder ingresar igual con tu clave o con Microsoft.', { okText: 'Quitar' }))) return;
      try { await api(`/me/passkeys/${encodeURIComponent(del.dataset.delkey)}`, { method: 'DELETE' }); navigate('#/profile'); } catch (er) { toastError(er); }
    }
    if (e.target.closest('[data-act=revoke-others]')) {
      try {
        const r = await api('/me/sessions/revoke-others', { method: 'POST', body: {} });
        toast(`Se cerraron ${r.revoked} sesión(es)`);
        navigate('#/profile');
      } catch (er) { toastError(er); }
    }
  });
}
