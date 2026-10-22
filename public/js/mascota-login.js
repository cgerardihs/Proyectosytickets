/* ============================================================
   Mascota en las pantallas de ingreso de la Mesa de Ayuda.

   Pantallas (las dos se dibujan en views/auth.js, antes de que haya sesión):
   - Ingreso (#loginForm): correo o usuario + clave. Es también el ingreso del
     superadministrador; cuando el ingreso es solo con Microsoft, el formulario
     queda dentro de "Ingreso del superadministrador" y la mascota igual lo sigue.
   - Instalación (#setupForm): correo + clave del primer administrador (y la
     clave de instalación, si se pide).

   - Dibuja la mascota (MASCOTA_HTML, marcado fijo) y la conecta a los campos.
   - Oculta el isotipo que ya estaba arriba (el triángulo no aparece dos veces).
   - «Ver clave»: primero cambia el tipo del campo y después la mascota espía.
   - Se apaga desde Configuración → General y marca («Mascota en el inicio de
     sesión»). El dato viaja en GET /api/auth/me sin sesión (público, junto con
     la marca). Si no llega, queda encendida.
   - Colores: con la marca de fábrica, los exactos del logo (mascota.css). Solo si
     alguien cambió el color principal o el de acento, la mascota los sigue.
   ============================================================ */
import { MASCOTA_HTML, conectarMascota } from './mascota.js';

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// Marca de fábrica del sistema (lib/seed.js → DEFAULT_BRAND)
const FABRICA = { color: '#c8102e', accent: '#f2a900' };
const NOOP = { exito: () => Promise.resolve(), error: () => {}, apagar: () => {} };

/** ¿Está encendida? Sin dato (o con un dato raro) queda encendida. */
export const mascotaEncendida = (cfg) => !(cfg && cfg.mascot === false);

/**
 * Arma la mascota en una pantalla de ingreso.
 * lugar: contenedor vacío donde va el dibujo · logo: el isotipo a ocultar (opcional)
 * user/pass: campos (user opcional) · ver: botón «Ver clave» (opcional, se muestra solo con la mascota)
 * brand: { color, accent } de la marca publicada · encendida: preferencia (true por defecto)
 * Devuelve { exito(): Promise, error(), apagar() }.
 */
export function montarMascota({ lugar, logo = null, user = null, pass, ver = null, brand = {}, encendida = true }) {
  if (!lugar || !pass || !encendida) {
    if (lugar) { lugar.innerHTML = ''; lugar.hidden = true; }
    if (logo) logo.hidden = false;
    if (ver) ver.hidden = true;
    return NOOP;
  }

  lugar.innerHTML = MASCOTA_HTML;
  lugar.hidden = false;
  if (logo) logo.hidden = true;
  if (ver) ver.hidden = false;

  // Colores: solo si la marca se cambió respecto de la de fábrica
  const caja = lugar.querySelector('#mascota');
  const pintar = (valor, fabrica, variable) => {
    const v = String(valor || '').trim();
    if (caja && HEX.test(v) && v.toLowerCase() !== fabrica) caja.style.setProperty(variable, v);
  };
  pintar(brand.color, FABRICA.color, '--ms-rojo');
  pintar(brand.accent, FABRICA.accent, '--ms-oro');

  // «Ver clave»: primero cambia el tipo del campo y después actúa la mascota (su listener de click va después de este)
  if (ver) {
    ver.addEventListener('mousedown', (e) => e.preventDefault()); // no le saca el foco a la clave
    ver.addEventListener('click', () => {
      const mostrar = pass.type === 'password';
      pass.type = mostrar ? 'text' : 'password';
      ver.textContent = mostrar ? 'Ocultar clave' : 'Ver clave';
      ver.setAttribute('aria-pressed', mostrar ? 'true' : 'false');
      if (document.activeElement !== pass) pass.focus();
    });
  }

  const m = conectarMascota(lugar, { email: user || undefined, password: pass, verContrasena: ver || undefined });
  // La página ya enfocó un campo antes de que la mascota estuviera conectada: que arranque en el gesto correcto
  if ((user && document.activeElement === user) || document.activeElement === pass) {
    document.activeElement.dispatchEvent(new FocusEvent('focus'));
  }

  // Después de un error, al volver a escribir deja de fruncir el ceño
  let enError = false;
  const salirDelError = (e) => {
    if (!enError) return;
    enError = false;
    m.estado(e.target === pass ? (pass.type === 'text' ? 'espiando' : 'tapando') : 'mirando');
  };
  if (user) user.addEventListener('input', salirDelError);
  pass.addEventListener('input', salirDelError);

  const sinMovimiento = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let activa = true;

  return {
    exito() {
      if (!activa) return Promise.resolve();
      m.estado('exito');
      m.soltar();
      // Deja ver el saltito antes de que se cierre la pantalla de ingreso
      return new Promise((r) => setTimeout(r, sinMovimiento ? 0 : 560));
    },
    error() { if (activa) { enError = true; m.estado('error'); } },
    apagar() {
      activa = false;
      m.soltar();
      lugar.innerHTML = '';
      lugar.hidden = true;
      if (logo) logo.hidden = false;
      if (ver) { ver.hidden = true; pass.type = 'password'; }
    },
  };
}
