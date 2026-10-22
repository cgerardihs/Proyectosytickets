/* ============================================================
   La mascota del ingreso.

   El logo de la compañía mira mientras se escribe el correo y se tapa los
   ojos con las manos cuando le toca el turno a la contraseña.

   ── Por qué está dibujada y no es una imagen ──────────────

   Porque tiene que moverse por partes —los ojos por un lado, las manos por
   otro— y porque así toma los colores de la marca: si una compañía cambia
   su color primario en Configuración → Apariencia, la mascota cambia con
   ella. Una imagen habría quedado con los colores de otro.

   ── Las medidas ──────────────────────────────────────────

   Las tres piezas están trazadas (potrace) directo del logo oficial de
   512×512, así que calzan con él al píxel. Salen del logo original: el triángulo va de la
   punta (253,17) a la base (y=392), la cara es el hueco blanco entre las
   tres piezas —x de 147 a 363, y de 180 a 290— y los ojos son dos
   semicírculos de radio 20 con trazo de 15, centrados en x=204,5 y x=306,5
   sobre la línea y=247.

   Los ojos cerrados NO son un estado inventado: son exactamente los del
   logo. La mascota en reposo es el logo, sin una línea de diferencia.

   ── Las manos ────────────────────────────────────────────

   Viven recortadas al hueco de la cara. En reposo están abajo, fuera del
   recorte, y por eso no se ven: no hay que esconderlas con opacidad ni
   quitarlas del DOM, simplemente están donde el recorte no llega.
   ============================================================ */

/** El dibujo. Sin interpolaciones: es marcado fijo. */
export const MASCOTA_HTML = `
<div class="mascota" id="mascota">
  <svg viewBox="40 25 432 385" role="img" aria-label="Mascota de la pantalla de ingreso">
    <path class="ms-rojo" d="M158.4 179.8 C157.9 179.7 157.9 179.0 158.5 178.2 C158.8 177.9 159.0 177.5 159.0 177.4 C159.0 177.3 160.0 175.5 161.3 173.3 C162.5 171.1 163.9 168.8 164.3 168.0 C164.7 167.2 165.2 166.3 165.5 166.0 C165.7 165.7 166.0 165.1 166.2 164.8 C166.4 164.4 166.7 163.9 166.8 163.6 C167.4 162.8 169.2 159.7 169.8 158.5 C170.9 156.6 184.6 132.8 186.1 130.1 C186.9 128.8 187.7 127.3 187.9 126.9 C188.2 126.5 188.7 125.6 189.1 124.9 C189.8 123.8 191.9 120.1 193.8 116.8 C194.1 116.1 194.8 115.1 195.2 114.4 C195.6 113.7 196.0 112.8 196.3 112.5 C196.5 112.1 198.4 108.7 200.6 104.9 C202.8 101.1 204.9 97.5 205.3 96.8 C205.6 96.2 206.7 94.2 207.7 92.5 C208.7 90.8 209.9 88.8 210.3 88.0 C210.7 87.2 211.2 86.3 211.5 86.0 C211.7 85.7 212.0 85.1 212.2 84.8 C212.7 83.8 214.0 81.5 214.6 80.5 C215.2 79.6 216.7 77.0 217.1 76.2 C217.2 76.0 217.5 75.4 217.9 74.9 C218.2 74.3 218.6 73.6 218.8 73.2 C219.1 72.7 220.9 69.5 221.5 68.5 C221.7 68.1 227.3 58.6 227.8 57.6 C230.3 53.3 233.9 49.3 237.5 46.9 C240.0 45.3 243.9 43.3 245.1 43.1 C245.5 43.0 246.2 42.8 246.5 42.6 C247.6 42.1 253.8 41.2 256.6 41.3 C258.0 41.3 259.9 41.4 260.9 41.6 C261.8 41.8 262.9 42.0 263.2 42.0 C265.7 42.0 271.1 46.3 276.3 52.3 C279.2 55.6 281.0 57.8 281.8 58.8 C282.0 59.1 282.9 60.4 283.9 61.6 C284.8 62.9 286.3 65.1 287.2 66.5 C288.0 67.9 289.1 69.8 289.6 70.6 C290.1 71.5 291.7 74.3 293.3 77.0 C294.8 79.7 296.6 82.7 297.1 83.6 C298.1 85.3 298.6 86.1 299.9 88.3 C300.1 88.8 301.7 91.5 303.4 94.4 C305.0 97.2 306.6 99.9 306.9 100.5 C308.5 103.3 309.1 104.3 312.5 110.1 C314.1 112.8 315.5 115.3 315.8 115.7 C316.0 116.1 316.4 116.8 316.7 117.2 C316.9 117.7 317.5 118.6 317.8 119.2 C318.4 120.3 320.0 123.1 324.1 130.1 C324.8 131.3 325.5 132.6 325.7 133.0 C326.0 133.3 327.2 135.5 328.5 137.8 C329.9 140.0 332.3 144.2 333.9 147.0 C335.5 149.8 337.1 152.5 337.4 153.0 C337.7 153.5 338.3 154.4 338.6 155.1 C339.8 157.2 340.3 158.1 342.6 162.1 C343.8 164.2 345.4 166.9 346.1 168.1 C346.8 169.3 347.6 170.7 347.9 171.1 C348.4 172.0 350.8 176.3 351.9 178.2 C352.3 178.9 352.5 179.4 352.3 179.5 C352.1 179.8 159.5 180.0 158.4 179.8Z"/>
    <path class="ms-tinta" d="M83.9 393.0 C76.3 391.6 70.3 387.5 65.6 380.6 C64.0 378.4 61.4 373.3 61.1 371.9 C61.0 371.5 60.7 370.7 60.5 370.3 C60.2 369.8 60.0 369.1 60.0 368.7 C60.0 368.3 59.8 367.6 59.5 367.1 C59.2 366.6 59.0 365.7 59.0 365.2 C59.0 364.7 58.8 363.8 58.6 363.3 C58.0 362.0 58.0 357.2 58.6 355.4 C58.8 354.7 59.0 353.8 59.0 353.4 C59.0 353.0 59.2 352.2 59.5 351.7 C59.7 351.3 60.0 350.5 60.1 350.0 C60.2 349.5 60.4 349.0 60.6 348.8 C60.8 348.6 61.0 348.1 61.2 347.7 C61.3 347.2 68.1 335.2 69.8 332.5 C69.9 332.3 71.7 329.1 73.8 325.5 C75.8 321.9 77.8 318.5 78.0 318.1 C80.0 314.8 81.0 312.9 81.0 312.8 C81.0 312.7 81.2 312.3 81.5 312.0 C81.7 311.6 82.3 310.8 82.7 310.0 C83.8 307.9 98.7 282.0 99.3 281.0 C99.9 280.1 100.4 279.1 101.1 277.9 C101.3 277.5 101.8 276.7 102.1 276.2 C103.0 274.6 104.9 271.4 105.0 271.1 C105.0 271.0 105.4 270.3 105.9 269.6 C106.3 268.9 107.1 267.6 107.6 266.8 C108.4 265.1 120.9 243.4 122.5 240.7 C123.5 239.1 124.3 237.7 125.3 235.7 C125.7 235.0 126.5 233.7 127.0 232.8 C127.6 231.9 128.0 231.1 128.0 231.1 C128.0 231.0 128.2 230.7 128.5 230.3 C128.7 229.9 129.3 229.0 129.7 228.2 C130.1 227.5 130.7 226.4 131.0 225.9 C131.3 225.3 131.8 224.5 132.1 223.9 C139.3 211.3 146.4 199.2 146.6 199.3 C146.8 199.4 146.9 210.5 147.0 242.3 L147.1 285.1 L147.9 286.5 C148.3 287.2 149.0 288.1 149.4 288.5 C150.2 289.2 150.3 289.4 150.2 290.6 L150.2 292.0 L180.1 292.0 L210.0 292.0 L210.5 293.1 C211.0 294.2 211.6 295.7 212.5 297.8 C212.8 298.5 213.3 299.6 213.5 300.1 C213.8 300.7 214.4 302.2 215.0 303.6 C216.8 308.0 217.3 309.1 217.5 309.4 C217.7 309.5 217.8 309.8 217.8 309.9 C217.8 310.1 218.0 310.9 218.3 311.6 C218.7 312.3 219.2 313.5 219.5 314.2 C219.8 315.0 220.3 316.1 220.6 316.8 C221.5 318.8 221.9 319.9 222.5 321.1 C224.1 325.1 226.1 329.7 226.4 330.3 C226.6 330.7 226.7 331.2 226.7 331.3 C226.7 331.5 227.0 332.1 227.3 332.9 C228.6 335.5 229.0 336.4 229.0 336.6 C229.0 336.7 229.2 337.3 229.5 338.0 C230.7 340.6 232.0 343.7 233.2 346.5 C234.0 348.4 234.4 349.5 235.4 351.6 C235.6 352.0 236.0 353.1 236.3 353.9 C236.9 355.3 239.0 360.2 239.5 361.4 C239.6 361.6 240.2 363.1 240.9 364.6 C241.5 366.1 242.3 367.8 242.5 368.4 C242.8 369.0 243.0 369.5 243.0 369.6 C243.0 369.8 243.2 370.4 243.5 371.0 C244.2 372.3 244.4 372.9 245.5 375.5 C245.9 376.5 246.4 377.6 246.5 377.9 C247.5 380.0 249.5 384.8 250.2 386.5 C250.6 387.7 251.2 388.9 251.4 389.3 C252.1 390.5 252.5 392.2 252.2 392.4 C252.0 392.5 222.8 392.7 187.2 392.7 C132.0 392.8 111.9 392.9 89.9 393.4 C87.1 393.4 85.6 393.3 83.9 393.0Z"/>
    <path class="ms-oro" d="M265.2 392.3 C264.9 392.3 264.5 392.0 264.3 391.8 C264.1 391.5 264.0 381.1 264.0 341.6 C264.0 299.0 264.1 291.8 264.4 291.4 C264.7 290.9 265.6 290.9 312.2 290.8 C352.0 290.6 359.7 290.6 360.2 290.3 C361.6 289.5 363.5 287.7 364.0 286.6 L364.6 285.4 L364.8 246.4 C364.9 224.9 365.1 206.6 365.1 205.6 C365.3 203.1 365.5 202.9 366.6 204.0 C367.4 204.8 368.2 206.1 370.1 209.5 C370.4 210.2 371.5 212.1 372.5 213.6 C373.4 215.2 375.0 218.0 376.0 219.8 C377.0 221.6 378.4 223.8 378.9 224.7 C379.5 225.6 380.0 226.5 380.0 226.6 C380.0 226.7 380.4 227.5 381.0 228.4 C381.5 229.2 382.4 230.7 382.9 231.6 C386.1 237.1 387.7 239.9 388.5 241.2 C389.6 243.0 394.2 251.1 396.2 254.6 C397.1 256.1 398.7 258.9 399.9 260.9 C401.0 262.8 402.8 265.8 403.8 267.6 C406.7 272.6 408.4 275.5 409.2 276.9 C410.7 279.4 411.0 279.9 411.8 281.4 C412.2 282.2 412.8 283.2 413.1 283.6 C413.6 284.3 414.0 285.1 416.3 289.2 C416.7 289.9 417.5 291.3 418.0 292.2 C418.6 293.1 419.6 294.7 420.1 295.8 C420.7 296.8 421.6 298.3 422.1 299.2 C422.6 300.0 423.4 301.5 423.9 302.3 C424.4 303.2 424.9 304.0 425.1 304.3 C425.3 304.5 425.6 305.0 425.7 305.4 C425.9 305.8 426.9 307.6 428.0 309.5 C431.2 314.8 431.6 315.5 433.0 318.0 C434.9 321.4 436.3 323.7 437.2 325.1 C437.6 325.8 438.0 326.4 438.0 326.5 C438.0 326.7 439.8 329.8 442.6 334.6 C443.5 336.1 444.8 338.3 445.5 339.6 C446.1 340.7 449.9 347.3 451.0 349.0 C452.3 351.0 453.0 352.9 453.4 355.3 C454.2 359.7 453.7 366.9 452.5 369.7 C452.2 370.3 452.0 371.0 452.0 371.2 C452.0 371.9 449.9 376.1 448.4 378.4 C446.8 380.8 443.6 384.2 441.0 386.1 C439.0 387.5 434.5 390.0 433.9 390.0 C433.7 390.0 432.8 390.3 432.0 390.6 C429.7 391.6 426.5 392.0 420.2 392.1 C413.1 392.3 266.1 392.4 265.2 392.3Z"/>

    <g class="ms-cerrados" id="ms-cerrados">
      <path d="M184.5 247 A20 20 0 0 1 224.5 247"/>
      <path d="M286.5 247 A20 20 0 0 1 326.5 247"/>
    </g>

    <g class="ms-abiertos" id="ms-abiertos">
      <circle class="ms-pupila" id="ms-p1" cx="204.5" cy="233" r="14"/>
      <circle class="ms-brillo" id="ms-b1" cx="209.5" cy="228" r="4"/>
      <circle class="ms-pupila" id="ms-p2" cx="306.5" cy="233" r="14"/>
      <circle class="ms-brillo" id="ms-b2" cx="311.5" cy="228" r="4"/>
    </g>

    <path class="ms-ceja" id="ms-c1" d="M182 208 L228 218"/>
    <path class="ms-ceja" id="ms-c2" d="M329 208 L283 218"/>

    <defs><clipPath id="ms-cara"><rect x="146" y="179" width="219" height="112"/></clipPath></defs>
    <g clip-path="url(#ms-cara)">
      <g class="ms-mano" id="ms-mano1" transform="translate(203 352)">
        <g transform="rotate(-7)">
          <rect x="-40" y="-10" width="80" height="52" rx="18"/>
          <rect x="-38" y="-34" width="17" height="38" rx="8.5"/>
          <rect x="-19" y="-40" width="17" height="44" rx="8.5"/>
          <rect x="2" y="-39" width="17" height="43" rx="8.5"/>
          <rect x="22" y="-32" width="17" height="36" rx="8.5"/>
          <path class="ms-palma" d="M-24 20 h48"/>
        </g>
      </g>
      <g class="ms-mano der" id="ms-mano2" transform="translate(308 352)">
        <g transform="rotate(7)">
          <rect x="-40" y="-10" width="80" height="52" rx="18"/>
          <rect x="-39" y="-32" width="17" height="36" rx="8.5"/>
          <rect x="-19" y="-39" width="17" height="43" rx="8.5"/>
          <rect x="2" y="-40" width="17" height="44" rx="8.5"/>
          <rect x="21" y="-34" width="17" height="38" rx="8.5"/>
          <path class="ms-palma" d="M-24 20 h48"/>
        </g>
      </g>
    </g>
  </svg>
</div>`;

/* Dónde queda cada mano: abajo del recorte, tapando el ojo, o a media
   altura cuando la persona pidió ver lo que escribe. */
const ABAJO = 352, TAPA = 244, ESPIA = 292;

/**
 * Conecta la mascota a los campos del formulario.
 *
 * Devuelve `{ estado, soltar }`: `estado(nombre)` la lleva a mano a
 * cualquiera de los seis gestos, y `soltar()` corta el parpadeo cuando la
 * pantalla se desmonta —sin eso quedaría un intervalo corriendo sobre
 * elementos que ya no existen.
 */
export function conectarMascota(raiz, { email, password, verContrasena } = {}) {
  const caja = raiz.querySelector('#mascota');
  if (!caja) return { estado: () => {}, soltar: () => {} };

  const cerrados = raiz.querySelector('#ms-cerrados');
  const abiertos = raiz.querySelector('#ms-abiertos');
  const mano1 = raiz.querySelector('#ms-mano1');
  const mano2 = raiz.querySelector('#ms-mano2');
  const cejas = [raiz.querySelector('#ms-c1'), raiz.querySelector('#ms-c2')];
  const ojos = ['ms-p1', 'ms-b1', 'ms-p2', 'ms-b2'].map(id => raiz.querySelector('#' + id));

  let cual = 'reposo';
  let mirada = { x: 0, y: 0 };
  let parpadeo = false;

  const moverPupilas = () => {
    const t = `translate(${(mirada.x * 9).toFixed(1)} ${(mirada.y * 5).toFixed(1)})`;
    for (const o of ojos) o.setAttribute('transform', t);
  };

  function pintar() {
    const mirando = (cual === 'mirando' || cual === 'error' || cual === 'espiando') && !parpadeo;
    abiertos.style.opacity = mirando ? '1' : '0';
    cerrados.style.opacity = mirando ? '0' : '1';

    const y1 = (cual === 'tapando' || cual === 'espiando') ? TAPA : ABAJO;
    const y2 = cual === 'tapando' ? TAPA : (cual === 'espiando' ? ESPIA : ABAJO);
    mano1.setAttribute('transform', `translate(203 ${y1})`);
    mano2.setAttribute('transform', `translate(308 ${y2})`);

    for (const c of cejas) c.style.opacity = cual === 'error' ? '1' : '0';
    caja.classList.toggle('tapando', cual === 'tapando' || cual === 'espiando');
  }

  function estado(nuevo) {
    cual = nuevo;
    if (nuevo === 'error') { mirada = { x: 0, y: .6 }; moverPupilas(); }
    if (nuevo === 'exito') {
      caja.classList.remove('salto');
      void caja.offsetWidth;          /* reinicia la animación */
      caja.classList.add('salto');
    }
    pintar();
  }

  /* La mirada sigue al cursor: cuanto más largo el texto, más a la derecha.
     El ancho se mide con un span fuera de pantalla porque un input no dice
     cuánto ocupa lo que tiene escrito. */
  function seguirTexto() {
    if (!email) return;
    const regla = document.createElement('span');
    regla.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:pre';
    regla.style.font = getComputedStyle(email).font;
    regla.textContent = email.value;
    document.body.appendChild(regla);
    const ancho = regla.offsetWidth;
    regla.remove();
    const util = Math.max(1, email.clientWidth - 22);
    mirada = { x: Math.min(1, ancho / util) * 1.6 - .8, y: .35 };
    moverPupilas();
  }

  if (email) {
    email.addEventListener('focus', () => { estado('mirando'); seguirTexto(); });
    email.addEventListener('input', seguirTexto);
    email.addEventListener('blur', () => { if (cual === 'mirando') estado('reposo'); });
  }
  if (password) {
    const gesto = () => (password.type === 'text' ? 'espiando' : 'tapando');
    password.addEventListener('focus', () => estado(gesto()));
    password.addEventListener('blur', () => {
      if (cual === 'tapando' || cual === 'espiando') estado('reposo');
    });
    if (verContrasena) {
      verContrasena.addEventListener('click', () => {
        if (cual === 'tapando' || cual === 'espiando') estado(gesto());
      });
    }
  }

  /* Un parpadeo cada tanto, sólo con los ojos abiertos: sin esto la cara
     queda congelada mirando fijo, que es lo contrario de lo que se busca. */
  const reloj = setInterval(() => {
    if (cual !== 'mirando') return;
    parpadeo = true; pintar();
    setTimeout(() => { parpadeo = false; pintar(); }, 130);
  }, 4200);

  pintar();
  return { estado, soltar: () => clearInterval(reloj) };
}
