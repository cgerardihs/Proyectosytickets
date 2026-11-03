// Imágenes pegadas en el cuerpo (v1.17.3): respuestas, notas, descripciones y comentarios de tareas.
// El editor las manda dentro del HTML como data:image/…;base64. Al guardar, cada una pasa a ser un adjunto "incrustado"
// (inline) y el cuerpo apunta a /api/attachments/<id>, que respeta los permisos del ticket o del proyecto. Al mandar un
// correo, esas imágenes viajan incrustadas (cid:), así el usuario también las ve en el cuerpo del mensaje.
import crypto from 'node:crypto';
import { q, one } from './db.js';
import { HttpError } from './http.js';

const MAX_IMAGE = 3 * 1024 * 1024;
const MAX_PER_BODY = 20;
const DATA_IMG = /src="data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)"/gi;
const EXT = { png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', webp: 'webp' };

/** Límite del cuerpo con imágenes pegadas (Vercel acepta hasta ~4,5 MB por pedido). */
export const BODY_WITH_IMAGES_MAX = 4_200_000;

/**
 * Guarda las imágenes pegadas de un cuerpo como adjuntos incrustados y devuelve el HTML que apunta a ellos.
 * Se indica a qué pertenecen: messageId (ticket), issueId (descripción de una tarea) o commentId (+ issueId).
 */
export async function materializeInlineImages(html, { messageId = null, issueId = null, commentId = null, userId = null } = {}) {
  if (!html || !/src="data:image\//i.test(html)) return html;
  const found = [...html.matchAll(DATA_IMG)];
  if (found.length > MAX_PER_BODY) throw new HttpError(400, `Se pueden pegar hasta ${MAX_PER_BODY} imágenes por mensaje`);
  const done = new Map();
  let n = 0;
  for (const m of found) {
    const uri = m[0];
    if (done.has(uri)) continue;
    const ext = EXT[m[1].toLowerCase()] || 'png';
    const b64 = m[2];
    const size = Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
    if (size > MAX_IMAGE) throw new HttpError(413, 'Una de las imágenes pegadas supera los 3 MB');
    n += 1;
    const row = await one(
      `insert into attachments(ticket_message_id,issue_id,issue_comment_id,filename,content_type,size,data_b64,uploaded_by,storage,inline,content_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'db',true,$9) returning id`,
      [messageId, issueId, commentId, `imagen-${n}.${ext}`, `image/${ext === 'jpg' ? 'jpeg' : ext}`, size, b64, userId, `img-${crypto.randomUUID()}`],
    );
    done.set(uri, `src="/api/attachments/${row.id}"`);
  }
  let out = html;
  for (const [from, to] of done) out = out.split(from).join(to);
  return out;
}

/**
 * Para mandar por correo: las imágenes propias (/api/attachments/<id>) pasan a viajar incrustadas en el mensaje (cid:).
 * Devuelve el HTML para el correo y los adjuntos incrustados que hay que sumar.
 */
export async function inlineImagesForEmail(html) {
  const ids = [...new Set([...String(html || '').matchAll(/src="\/api\/attachments\/(\d+)"/g)].map((m) => Number(m[1])))].slice(0, 30);
  if (!ids.length) return { html, attachments: [] };
  const rows = await q('select id, filename, content_type, size, data_b64, storage, external_ref from attachments where id = any($1::int[])', [ids]);
  const { attachmentBuffer } = await import('./tickets-core.js');
  const attachments = [];
  let out = html;
  for (const a of rows) {
    if (!/^image\//i.test(a.content_type || '')) continue;
    let data;
    try { data = (await attachmentBuffer(a)).toString('base64'); } catch { continue; }
    const cid = `img${a.id}@mesa-de-ayuda`;
    out = out.split(`src="/api/attachments/${a.id}"`).join(`src="cid:${cid}"`);
    attachments.push({ name: a.filename, type: a.content_type, data, inline: true, contentId: cid });
  }
  return { html: out, attachments };
}
