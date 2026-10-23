// v1.13.2: formato en los correos (negrita, cursiva, colores, resaltado) y párrafos que se ven separados en Outlook.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPERADMIN_PASSWORD = 'Super-Clave-Muy-Larga-2026';
const { makeClient } = await import('./helpers.mjs');
const { renderBody, renderSubject } = await import('../lib/mail-templates.js');
const { layout } = await import('../lib/mail.js');

test('preparación', async () => {
  const r = await makeClient().post('/setup', { preset: 'hanseatica', admin: { name: 'Carlos Gerardi', email: 'cgerardi@hanseatica.com', password: 'Sol-de-Mayo-2026' }, demo: false });
  assert.ok(r.status < 300);
});

test('formato: negrita, cursiva, colores y resaltado', () => {
  const ctx = { contact: { name: 'Ana Ruiz', email: 'a@x.com' }, ticket: { number: 9, subject: 'x' } };
  assert.equal(renderBody('Hola **{{contacto.nombre}}**, _gracias_.', ctx), '<p>Hola <b>Ana</b>, <i>gracias</i>.</p>');
  assert.equal(renderBody('[rojo]Atención[/rojo] [marca]marca[/marca] [resaltado]hoy[/resaltado]', ctx, { color: '#123abc' }),
    '<p><span style="color:#c8102e">Atención</span> <span style="color:#123abc">marca</span> <span style="background:#fef08a;padding:0 2px">hoy</span></p>');
  assert.equal(renderBody('**[verde]ok[/verde]**', ctx), '<p><b><span style="color:#059669">ok</span></b></p>', 'se puede combinar');
  assert.equal(renderBody('variable_con_guiones y snake_case', ctx), '<p>variable_con_guiones y snake_case</p>', 'los guiones bajos dentro de palabras no son cursiva');
  assert.equal(renderBody('[violeta]x[/violeta] <b>html</b>', ctx), '<p>[violeta]x[/violeta] &lt;b&gt;html&lt;/b&gt;</p>', 'colores desconocidos y HTML quedan como texto');
});

test('lo que escribe el usuario nunca se toma como formato', () => {
  const ctx = { contact: { name: '**Juan** [rojo]x[/rojo]', email: 'j@x.com' }, ticket: { number: 9, subject: '_hola_ <script>' } };
  assert.equal(renderBody('{{contacto.nombre_completo}} — {{ticket.asunto}}', ctx), '<p>**Juan** [rojo]x[/rojo] — _hola_ &lt;script&gt;</p>');
});

test('el asunto es texto plano (se sacan las marcas) y un párrafo vacío no aparece', () => {
  assert.equal(renderSubject('**Urgente** [rojo]{{ticket.asunto}}[/rojo]', { ticket: { number: 3, subject: 'VPN' } }), '[#3] Urgente VPN');
  assert.equal(renderBody('Hola\n\n**{{sistema.mensaje}}**\n\nChau', { system: { message: '' } }), '<p>Hola</p><p>Chau</p>');
});

test('saltos de línea: línea en blanco = párrafo, salto simple = renglón; con margen en cada párrafo (Outlook)', async () => {
  const body = renderBody('Uno\nDos\n\nTres', {});
  assert.equal(body, '<p>Uno<br>Dos</p><p>Tres</p>');
  const html = await layout(`${body}<ol><li>a</li></ol>`);
  assert.match(html, /<p style="margin:0 0 12px">Uno<br>Dos<\/p><p style="margin:0 0 12px">Tres<\/p>/);
  assert.match(html, /<ol style="margin:0 0 12px;padding-left:22px"><li style="margin:0 0 4px">a<\/li><\/ol>/);
  assert.match(await layout('<p style="color:red">x</p>'), /<p style="color:red">x<\/p>/, 'los párrafos con estilo propio no se tocan');
});
