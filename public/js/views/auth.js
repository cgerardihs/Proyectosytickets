import { api, esc, icon, toastError, applyBrand } from '../core.js';
import { montarMascota, mascotaEncendida } from '../mascota-login.js';

/** Logo de la pantalla de ingreso: el de la marca cargada o, por defecto, el de Hanseatica. */
function lockup(brand = {}) {
  if (brand.logo) return `<div class="auth-logo custom"><img src="${esc(brand.logo)}" alt="${esc(brand.name || '')}"></div>`;
  const name = brand.name || 'Hanseatica';
  const hanseatica = name.trim().toLowerCase() === 'hanseatica';
  // El isotipo lleva id: con la mascota encendida se oculta (la mascota ES el isotipo)
  return `<div class="auth-logo"><img class="auth-iso" src="/brand/isotipo.svg" alt="" width="58" height="50"><div><b>${esc(name.toUpperCase())}</b>${hanseatica ? '<small>Compañía de Seguros</small>' : ''}</div></div>`;
}

export function renderLogin(app, me, query) {
  if (me.brand) applyBrand(me.brand);
  app.innerHTML = `
  <div class="auth">
    <div class="auth-card">
      <div class="auth-mascota" id="loginMascota" hidden></div>
      ${lockup(me.brand)}
      <div class="auth-product"><b>${esc(me.brand?.product || 'Mesa de Ayuda')}</b><small>Tickets y proyectos</small></div>
      ${me.msOnly ? `<a class="btn primary block ms-main" href="/api/auth/ms/start">${msLogo()} Ingresar con Microsoft</a>
      <p class="form-error" ${query.error ? '' : 'hidden'}>${esc(query.error || '')}</p>
      <details class="su-login"><summary>Ingreso del superadministrador</summary>` : ''}
      <form id="loginForm" autocomplete="on">
        <label class="field"><span>Correo o usuario</span><input class="input" name="email" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required ${me.msOnly ? '' : 'autofocus'}></label>
        <label class="field"><span>Clave</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
        <div class="ver-clave-row"><button type="button" class="link-btn ver-clave" id="loginVer" aria-pressed="false" hidden>Ver clave</button></div>
        <p class="form-error" id="loginErr" ${query.error ? '' : 'hidden'}>${esc(query.error || '')}</p>
        <button class="btn primary block" type="submit">Ingresar</button>
      </form>
      ${me.msOnly ? '</details>' : `<div class="or"><span>o</span></div>
      <a class="btn block ms" id="btnMs" href="/api/auth/ms/start">${msLogo()} Ingresar con Microsoft</a>`}
    </div>
  </div>`;
  // Si el ingreso con Microsoft todavía no está configurado, el botón avisa en lugar de llevar a un error
  document.getElementById('btnMs')?.addEventListener('click', (e) => {
    if (me.msEnabled) return;
    e.preventDefault();
    const err = document.getElementById('loginErr');
    err.textContent = 'El ingreso con Microsoft todavía no está configurado. Un administrador lo activa en Configuración → Microsoft 365. Mientras tanto, ingresá con tu usuario y clave.';
    err.hidden = false;
  });
  const form = document.getElementById('loginForm');
  const masc = armarMascota(app, { form, user: form.email, pass: form.password, ver: document.getElementById('loginVer'), brand: me.brand, encendida: mascotaEncendida(me) });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('loginErr');
    err.hidden = true;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/auth/login', { method: 'POST', body: { email: form.email.value, password: form.password.value } });
      await masc.exito(); // el saltito, antes de cerrar el ingreso
      location.hash = location.hash.includes('login') ? '#/' : location.hash;
      location.reload();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
      masc.error();
    }
  });
}

/**
 * Mascota en una pantalla de ingreso de esta app: va arriba de la tarjeta y oculta el isotipo del encabezado.
 * extraPass: otro campo de clave de la misma pantalla (clave de instalación): al enfocarlo también se tapa los ojos.
 */
function armarMascota(app, { user, pass, ver, brand = {}, encendida = true, extraPass = null }) {
  const card = app.querySelector('.auth-card');
  const masc = montarMascota({ lugar: card.querySelector('.auth-mascota'), logo: card.querySelector('.auth-logo .auth-iso'), user, pass, ver, brand, encendida });
  card.classList.toggle('con-mascota', encendida);
  if (encendida && extraPass) {
    // Se reenvía el foco de ese campo como si fuera la clave principal (la mascota solo conoce un campo de clave)
    extraPass.addEventListener('focus', () => pass.dispatchEvent(new FocusEvent('focus')));
    extraPass.addEventListener('blur', () => pass.dispatchEvent(new FocusEvent('blur')));
    extraPass.addEventListener('input', () => pass.dispatchEvent(new Event('input'))); // vuelve a escribir: deja de fruncir el ceño
  }
  return masc;
}

function msLogo() {
  return '<svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>';
}

export function renderSetup(app, status) {
  app.innerHTML = `
  <div class="auth">
    <div class="auth-card wide">
      <div class="auth-mascota" id="setupMascota" hidden></div>
      ${lockup()}
      <div class="auth-product"><b>Instalación</b><small>Se crean las tablas en Neon y el primer administrador</small></div>
      ${!status.dbConfigured ? `<div class="callout warn">${icon('alert', 16)} Falta la variable <code>DATABASE_URL</code> en Vercel. Configurala y volvé a desplegar.</div>` : ''}
      <form id="setupForm">
        <div class="grid2">
          <label class="field"><span>Configuración inicial</span>
            <select class="input" name="preset">
              <option value="hanseatica">Hanseatica (grupos, categorías, agentes y estados actuales)</option>
              <option value="generic">Genérica (para otra empresa)</option>
            </select></label>
          <label class="field"><span>Primer número de ticket</span><input class="input" name="start_number" type="number" min="1" value="3500"><small class="hint">Para continuar la numeración de Desk365</small></label>
        </div>
        <h4>Administrador</h4>
        <div class="grid2">
          <label class="field"><span>Nombre</span><input class="input" name="name" required value="Carlos Gerardi"></label>
          <label class="field"><span>Correo</span><input class="input" name="email" type="email" required value="cgerardi@hanseatica.com"></label>
          <label class="field"><span>Clave (mín. 10)</span><input class="input" name="password" type="password" minlength="10" required autocomplete="new-password"><span class="ver-clave-row"><button type="button" class="link-btn ver-clave" id="setupVer" aria-pressed="false" hidden>Ver clave</button></span></label>
          ${status.needsKey ? '<label class="field"><span>Clave de instalación (SETUP_KEY)</span><input class="input" name="setup_key" type="password" required></label>' : '<span></span>'}
        </div>
        <label class="check"><input type="checkbox" name="demo" checked> Cargar datos de ejemplo (un ticket y un proyecto DEMO con sprint)</label>
        <p class="form-error" id="setupErr" hidden></p>
        <button class="btn primary block" type="submit">Instalar</button>
      </form>
    </div>
  </div>`;
  const f = document.getElementById('setupForm');
  const masc = armarMascota(app, { form: f, user: f.email, pass: f.password, ver: document.getElementById('setupVer'), extraPass: f.setup_key, encendida: mascotaEncendida(status) });
  f.preset.addEventListener('change', () => {
    if (f.preset.value === 'generic') { f.name.value = ''; f.email.value = ''; f.start_number.value = 1; }
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Instalando…';
    try {
      await api('/setup', {
        method: 'POST',
        body: {
          preset: f.preset.value, start_number: Number(f.start_number.value), demo: f.demo.checked, setup_key: f.setup_key?.value,
          admin: { name: f.name.value, email: f.email.value, password: f.password.value },
        },
      });
      await masc.exito();
      location.hash = '#/';
      location.reload();
    } catch (ex) {
      masc.error();
      const err = document.getElementById('setupErr');
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Instalar';
      toastError(ex);
    }
  });
}
