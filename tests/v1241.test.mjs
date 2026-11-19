// v1.24.1: "Enviar una prueba" (Configuración → Correos a los usuarios) va al correo que se indica.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
process.env.RESEND_API_KEY = 're_prueba';
process.env.MAIL_FROM = 'Mesa de Ayuda <soporte@hanseatica.com>';
const sent = [];
let failNext = '';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    if (failNext) { const m = failNext; failNext = ''; return new Response(JSON.stringify({ message: m }), { status: 422, headers: { 'content-type': 'application/json' } }); }
    sent.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ id: 're_x' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};
const { makeClient } = await import('./helpers.mjs');
const admin = makeClient();
const sup = makeClient();
const ok = (r, msg) => assert.ok(r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`);

test('preparación', async () => {
  ok(await admin.post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false }));
  ok(await sup.post('/auth/login', { email: 'superadmin', password: process.env.SUPERADMIN_PASSWORD }));
});

test('la prueba va al correo indicado', async () => {
  const r = await sup.post('/admin/mail-templates/test', { key: 'auto_reply', to: 'Prueba.Destino@Hanseatica.com' });
  ok(r);
  assert.equal(r.data.to, 'prueba.destino@hanseatica.com');
  assert.deepEqual([].concat(sent.at(-1).to), ['prueba.destino@hanseatica.com']);
  assert.match(sent.at(-1).subject, /^\[Prueba\]/);
});

test('el superadmin sin correo tiene que indicarlo; un correo inválido se rechaza en castellano', async () => {
  const r = await sup.post('/admin/mail-templates/test', { key: 'created' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Indicá a qué correo/);
  const bad = await sup.post('/admin/mail-templates/test', { key: 'created', to: 'superadmin' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /no es válido/);
});

test('un administrador con correo real sigue pudiendo mandársela sin indicarlo', async () => {
  const r = await admin.post('/admin/mail-templates/test', { key: 'resolved' });
  ok(r);
  assert.equal(r.data.to, 'cgerardi@hanseatica.com');
});

test('si el servicio de correo rechaza el destino, el error sale en castellano', async () => {
  failNext = "At least one recipient is not valid., Recipient 'x' is not resolved.";
  const r = await admin.post('/admin/mail-templates/test', { key: 'resolved', to: 'no.existe@hanseatica.com' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'El correo de destino no es válido o no existe');
});
