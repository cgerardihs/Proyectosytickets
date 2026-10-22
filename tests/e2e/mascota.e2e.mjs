// Pruebas en navegador (Playwright) de la mascota en las pantallas de ingreso: instalación e ingreso.
// Correr con: npm run test:e2e   (la primera vez: npx playwright install chromium)
// Levanta su propio servidor con una base en memoria en un puerto libre; no toca la base de desarrollo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* sin Playwright instalado */ }

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const ADMIN = { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' };
const SETUP_KEY = 'clave-de-instalacion-e2e';

let server;
let base;
let browser;
let dir;

test.before(async () => {
  if (!chromium) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mascota-e2e-'));
  const port = await freePort();
  base = `http://localhost:${port}`;
  server = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), PGLITE: path.join(dir, 'db'), SUPERADMIN_PASSWORD: 'Super-Clave-Muy-Larga-2026', SESSION_SECRET: 'secreto-e2e-muy-largo-para-firmar-1234567890', SETUP_KEY, LOG_SILENT: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/api/health`)).status < 500) break; } catch { /* todavía no */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  browser = await chromium.launch();
});

test.after(async () => {
  await browser?.close();
  server?.kill();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const skip = () => (!chromium ? 'Playwright no está instalado (npm i y npx playwright install chromium)' : false);

// Lectura de los gestos (lo que pide el kit de la mascota)
const leer = (page) => page.evaluate(() => {
  const g = (id) => document.getElementById(id);
  return {
    // La opacidad que fija la mascota (la computada pasa por una transición de 0,12 s)
    abiertos: g('ms-abiertos') && (g('ms-abiertos').style.opacity || getComputedStyle(g('ms-abiertos')).opacity),
    p1: g('ms-p1')?.getAttribute('transform') || '',
    mano1: g('ms-mano1')?.getAttribute('transform'),
    mano2: g('ms-mano2')?.getAttribute('transform'),
    ceja: g('ms-c1') && (g('ms-c1').style.opacity || getComputedStyle(g('ms-c1')).opacity),
    foco: document.activeElement?.name || '',
  };
});

async function gestosBasicos(page, { user, pass, ver }) {
  await page.locator(user).blur();
  await page.locator(user).click();
  await page.locator(user).pressSequentially('cgerardi@hanseatica.com', { delay: 5 });
  let s = await leer(page);
  assert.equal(s.abiertos, '1', 'al escribir el usuario abre los ojos');
  assert.match(s.p1, /^translate\(/, 'y las pupilas siguen el texto');
  await page.locator(pass).click();
  s = await leer(page);
  assert.equal(s.abiertos, '0');
  assert.equal(s.mano1, 'translate(203 244)', 'al enfocar la clave se tapa los ojos');
  await page.locator(ver).click();
  s = await leer(page);
  assert.equal(s.mano2, 'translate(308 292)', 'con "Ver clave" espía con un ojo');
  assert.equal(s.foco, 'password', 'y la clave no pierde el foco');
  assert.equal(await page.locator(pass).getAttribute('type'), 'text');
  await page.locator(ver).click();
  assert.equal(await page.locator(pass).getAttribute('type'), 'password');
}

test('instalación: mascota, gestos, error con la clave de instalación mal y saltito al instalar', { skip: skip() }, async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/`);
  await page.waitForSelector('#setupForm #mascota, #setupForm');
  assert.equal(await page.locator('#mascota').count(), 1, 'la mascota aparece');
  assert.equal(await page.locator('.auth-logo .auth-iso').isHidden(), true, 'el isotipo no se duplica');
  await page.fill('[name=name]', ADMIN.name);
  await page.fill('[name=email]', '');
  await gestosBasicos(page, { user: '#setupForm [name=email]', pass: '#setupForm [name=password]', ver: '#setupVer' });
  await page.fill('#setupForm [name=password]', ADMIN.password);
  await page.locator('[name=setup_key]').click();
  assert.equal((await leer(page)).mano1, 'translate(203 244)', 'la clave de instalación también tapa los ojos');
  await page.fill('[name=setup_key]', 'otra-clave');
  await page.uncheck('[name=demo]');
  await page.click('#setupForm button[type=submit]');
  await page.waitForSelector('#setupErr:not([hidden])');
  assert.equal((await leer(page)).ceja, '1', 'con la clave mal frunce el ceño');
  await page.fill('[name=setup_key]', SETUP_KEY);
  assert.equal((await leer(page)).ceja, '0', 'al volver a escribir deja de fruncirlo');
  await page.click('#setupForm button[type=submit]');
  await page.waitForSelector('#mascota.salto');
  assert.equal(await page.locator('#setupForm').count(), 1, 'el saltito se ve antes de cerrar la instalación');
  await page.waitForSelector('.rail', { timeout: 20000 }); // la instalación deja la sesión del administrador abierta
  assert.equal(await page.locator('#mascota').count(), 0, 'con sesión no se arma la mascota');
  await page.close();
});

test('ingreso: mascota, gestos, clave mal, saltito y recién después la app', { skip: skip() }, async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/`);
  await page.waitForSelector('#loginForm');
  assert.equal(await page.locator('#mascota').count(), 1);
  assert.equal(await page.locator('.auth-logo .auth-iso').isHidden(), true);
  // Arranca en el gesto correcto: el correo ya tenía el foco al cargar
  assert.equal((await leer(page)).abiertos, '1', 'el correo enfocado al cargar ya lo mira');
  // Colores de fábrica: exactos del logo
  const colores = await page.evaluate(() => { const c = getComputedStyle(document.getElementById('mascota')); return [c.getPropertyValue('--ms-rojo').trim(), c.getPropertyValue('--ms-oro').trim()]; });
  assert.deepEqual(colores.map((x) => x.toUpperCase()), ['#CE1C3C', '#F8BA03']);
  await page.fill('#loginForm [name=email]', '');
  await gestosBasicos(page, { user: '#loginForm [name=email]', pass: '#loginForm [name=password]', ver: '#loginVer' });
  await page.fill('#loginForm [name=password]', 'clave-equivocada-1');
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#loginErr:not([hidden])');
  assert.equal((await leer(page)).ceja, '1', 'clave mal: cejas');
  await page.locator('#loginForm [name=password]').fill(ADMIN.password);
  assert.equal((await leer(page)).ceja, '0');
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#mascota.salto');
  assert.equal(await page.locator('#loginForm').count(), 1, 'el saltito antes de cerrar el ingreso');
  await page.waitForSelector('.rail', { timeout: 20000 });
  // Con sesión guardada no se arma la mascota
  await page.goto(`${base}/`);
  await page.waitForSelector('.rail');
  assert.equal(await page.locator('#mascota').count(), 0);
  await page.close();
});

test('configuración: apagada no aparece y el ingreso funciona igual; con otra marca sigue sus colores', { skip: skip() }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const api = (method, url, body) => page.evaluate(async ([m, u, b]) => (await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).status, [method, url, body]);
  await page.goto(`${base}/`);
  await page.fill('#loginForm [name=email]', ADMIN.email);
  await page.fill('#loginForm [name=password]', ADMIN.password);
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('.rail');
  // El interruptor está en Configuración → General y marca, encendido de fábrica
  await page.goto(`${base}/#/settings/general`);
  await page.waitForSelector('[name=login_mascot]');
  assert.equal(await page.isChecked('[name=login_mascot]'), true);
  await page.uncheck('[name=login_mascot]');
  await page.click('form[data-form=brand] button.primary');
  await page.waitForSelector('.toast');
  assert.equal(await api('POST', '/api/auth/logout', {}), 200);

  const anon = await browser.newPage();
  await anon.goto(`${base}/`);
  await anon.waitForSelector('#loginForm');
  assert.equal(await anon.locator('#mascota').count(), 0, 'apagada: no hay mascota');
  assert.equal(await anon.locator('.auth-logo .auth-iso').isVisible(), true, 'vuelve el isotipo');
  assert.equal(await anon.locator('#loginVer').isHidden(), true);
  await anon.fill('#loginForm [name=email]', ADMIN.email);
  await anon.fill('#loginForm [name=password]', ADMIN.password);
  await anon.click('#loginForm button[type=submit]');
  await anon.waitForSelector('.rail', { timeout: 20000 });
  // Encenderla otra vez y cambiar la marca: la mascota toma los colores nuevos
  assert.equal(await anon.evaluate(async () => (await fetch('/api/admin/settings/brand', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login_mascot: true, color: '#1d4ed8', accent: '#10b981' }) })).status), 200);
  await anon.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  await anon.goto(`${base}/`);
  await anon.waitForSelector('#mascota');
  const colores = await anon.evaluate(() => { const c = getComputedStyle(document.getElementById('mascota')); return [c.getPropertyValue('--ms-rojo').trim(), c.getPropertyValue('--ms-oro').trim()]; });
  assert.deepEqual(colores, ['#1d4ed8', '#10b981']);
  await anon.close();
  await ctx.close();
});
