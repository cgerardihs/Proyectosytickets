// Ingreso, sesiones y passkeys.
import crypto from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { q, one, tx } from '../db.js';
import {
  currentUser, requireUser, hashPassword, verifyPassword, createSession, destroySession, revokeUserSessions, signToken, verifyToken,
  isSuper, superadminEnabled, superadminUser, checkSuperadmin, currentSessionHash, deviceCookie, trustedDevice, deviceBinding,
} from '../auth.js';
import { audit, clientIp } from '../audit.js';
import { bad, notFound, HttpError, redirect, parseCookies } from '../http.js';
import { appUrl } from '../mail.js';
import { fetchx } from '../fetchx.js';
import { m365Config, userInGroup, m365Log } from '../m365.js';
import { hit, reset, undoHit, TooManyRequests, limitIp } from '../ratelimit.js';
import { v, parse, checkPasswordPolicy } from '../validate.js';
import { SCHEMA_VERSION } from '../migrations.js';
import { migrate, appliedVersion } from '../migrate.js';
import { getSetting } from '../settings.js';
import { portalMicrosoft, createPortalSession, sessionEmails, isGuestAccount } from '../portal-session.js';

const WINDOW = 15 * 60;
const MAX_FAIL_ACCOUNT_IP = 5; // por cuenta + IP (el usuario legítimo desde otra red no queda bloqueado)
const MAX_FAIL_ACCOUNT = 50; // por cuenta, desde cualquier IP (ataques distribuidos). Passkey y Microsoft siguen disponibles.
const RECENT_AUTH_MIN = 10; // para registrar passkeys hay que haber ingresado hace poco
const MAX_ATTEMPTS_IP = 30; // por IP, contra cualquier cuenta (relleno de credenciales)

/** Ingreso con Microsoft: requiere Tenant/Client (Configuración o Vercel), MS_CLIENT_SECRET y el módulo activo. */
export async function msLogin() {
  const c = await m365Config().catch(() => null);
  if (!c || !c.connected || c.login.enabled === false) return null;
  return c;
}

/** Crea o actualiza la fila del superadmin (la clave vive solo en Vercel). */
async function ensureSuperadmin() {
  if ((await appliedVersion()) < SCHEMA_VERSION) await migrate();
  const login = superadminUser();
  const clash = await one(`select id from users where email=$1 and role<>'superadmin'`, [login]);
  if (clash) throw new HttpError(409, 'SUPERADMIN_USER coincide con el correo de un agente. Usá otro usuario.');
  const existing = await one(`select * from users where role='superadmin' order by id limit 1`);
  if (existing) return one(`update users set email=$2, active=true, password_hash=null, last_login_at=now() where id=$1 returning *`, [existing.id, login]);
  return one(`insert into users(name,email,role,color,last_login_at) values ('Superadministrador',$1,'superadmin','#111827',now()) returning *`, [login]);
}

// ---------- WebAuthn ----------
function rp(req) {
  const origin = appUrl(req);
  return { origin, rpID: new URL(origin).hostname, rpName: 'Mesa de Ayuda' };
}

async function saveChallenge(challenge, kind, userId = null) {
  const id = crypto.randomBytes(18).toString('base64url');
  await q(`insert into webauthn_challenges(id,challenge,user_id,kind,expires_at) values ($1,$2,$3,$4, now() + interval '5 minutes')`, [id, challenge, userId, kind]);
  if (Math.random() < 0.1) await q('delete from webauthn_challenges where expires_at < now()').catch(() => {});
  return id;
}

/** Usa el desafío una sola vez. */
async function takeChallenge(id, kind) {
  const c = await one('delete from webauthn_challenges where id=$1 and kind=$2 returning challenge, user_id, expires_at', [String(id || '').slice(0, 64), kind]);
  if (!c || new Date(c.expires_at) < new Date()) throw bad('El desafío venció. Probá de nuevo.');
  return c;
}

const credentialSchema = v.object({
  id: v.string({ min: 1, max: 1024, pattern: /^[\w-]+$/ }),
  rawId: v.string({ min: 1, max: 1024, pattern: /^[\w-]+$/ }),
  type: v.enum(['public-key']),
  response: v.any(),
  clientExtensionResults: v.any({ optional: true }),
  authenticatorAttachment: v.string({ max: 40, optional: true, nullable: true }),
}, { unknown: 'strip' });

export function authRoutes(r) {
  // ---------- Usuario y clave ----------
  r.post('/auth/login', async ({ body, req }) => {
    const b = parse(v.object({ email: v.string({ min: 1, max: 254 }), password: v.string({ min: 1, max: 256, trim: false }) }), body);
    const email = b.email.toLowerCase();
    const ip = clientIp(req);
    const keys = { ip: `login:ip:${ip}`, acctIp: `login:fail:${email}:${ip}`, acct: `login:fail:${email}` };
    // 1) Por IP: cada intento cuenta (relleno de credenciales contra muchas cuentas)
    const ipHits = await hit(keys.ip, WINDOW);
    if (ipHits.count > MAX_ATTEMPTS_IP) throw new TooManyRequests('Demasiados intentos desde esta conexión. Esperá unos minutos.', ipHits.reset);
    // 2) Por cuenta + IP: se cuenta ANTES de verificar, en una operación atómica (pedidos en paralelo no pasan el límite)
    const a1 = await hit(keys.acctIp, WINDOW);
    if (a1.count > MAX_FAIL_ACCOUNT_IP) throw new TooManyRequests('Demasiados intentos fallidos. Esperá 15 minutos y probá de nuevo.', a1.reset);
    const isSu = superadminEnabled() && email === superadminUser();
    const u = isSu ? null : await one(`select id,email,name,role,active,password_hash from users where email=$1 and role<>'superadmin'`, [email]).catch((e) => {
      if (e.code === '42P01') throw new HttpError(503, 'El sistema todavía no está instalado');
      throw e;
    });
    const target = isSu ? await one(`select id, role from users where role='superadmin' order by id limit 1`).catch(() => null) : u;
    // 3) Por cuenta, desde cualquier IP: contador atómico ANTES de verificar (los pedidos en paralelo no pasan el tope).
    //    Solo llegan acá los intentos de IPs no bloqueadas, y un ingreso correcto descuenta el suyo.
    //    Un navegador donde ya se ingresó bien (cookie de dispositivo atada a la clave actual) no queda bloqueado:
    //    así un atacante con muchas IPs no puede dejar afuera al dueño de la cuenta, incluido el superadmin.
    const trusted = target ? trustedDevice(req, target.id, await deviceBinding(isSu ? { role: 'superadmin' } : u)) : false;
    const a2 = await hit(keys.acct, WINDOW);
    if (!trusted && a2.count > MAX_FAIL_ACCOUNT) {
      // Mismo mensaje para cualquier cuenta (no revela cuál es la del superadmin)
      throw new TooManyRequests('La cuenta está bloqueada temporalmente por intentos fallidos. Ingresá desde un navegador donde ya hayas entrado, con passkey o con Microsoft, o esperá 15 minutos.', a2.reset);
    }
    const fail = async (extra = {}) => {
      await audit(req, null, 'login_failed', { login: email, trusted_device: trusted || undefined, ...extra });
      throw new HttpError(401, 'Usuario o clave incorrectos');
    };
    const success = async (user, method, extra = {}) => {
      await Promise.all([reset(keys.acctIp), undoHit(keys.acct), audit(req, user, 'login', extra)]);
      const binding = await deviceBinding(method === 'superadmin' ? { role: 'superadmin' } : await one('select password_hash from users where id=$1', [user.id]));
      return { ok: true, cookie: [await createSession(req, user.id, method), deviceCookie(req, user.id, binding)] };
    };
    // Superadmin: usuario y clave definidos en Vercel (SUPERADMIN_USER / SUPERADMIN_PASSWORD)
    if (isSu) {
      if (!checkSuperadmin(email, b.password)) {
        // Mismo tiempo de respuesta que una cuenta común (no se distingue el usuario del superadmin)
        await verifyPassword(b.password, null);
        return fail({ superadmin: true });
      }
      const su = await ensureSuperadmin();
      return success(su, 'superadmin', { superadmin: true });
    }
    const ms = await msLogin();
    if (ms?.login.only_microsoft) throw new HttpError(403, 'El ingreso es solo con la cuenta de Microsoft o con passkey.');
    const check = await verifyPassword(b.password, u?.active ? u.password_hash : null);
    if (!u || !u.active || !check.ok) return fail();
    if (check.rehash) await q('update users set password_hash=$2 where id=$1', [u.id, await hashPassword(b.password)]);
    await q('update users set last_login_at=now() where id=$1', [u.id]);
    return success(u, 'password', { rehash: check.rehash || undefined });
  }, { setCookie: true });

  r.post('/auth/logout', async ({ req }) => ({ ok: true, cookie: await destroySession(req) }), { setCookie: true });

  r.get('/auth/me', async ({ req }) => {
    const u = await currentUser(req);
    const ms = await msLogin();
    if (!u) {
      const b = (await getSetting('brand').catch(() => null)) || {};
      const brand = { name: b.name || 'Hanseatica', product: b.product || 'Mesa de Ayuda', color: b.color || '', accent: b.accent || '', logo: b.logo || '' };
      // mascot: la preferencia viaja acá porque el ingreso se dibuja antes de que haya sesión
      return { user: null, msEnabled: Boolean(ms), msOnly: Boolean(ms?.login.only_microsoft), passkeys: process.env.PASSKEYS_ENABLED === '1', brand, mascot: b.login_mascot !== false };
    }
    let ver = await appliedVersion();
    // Las migraciones se aplican solas al primer ingreso después de publicar una versión nueva.
    if (ver > 0 && ver < SCHEMA_VERSION) ver = await migrate();
    return { user: u, msEnabled: Boolean(ms), passkeys: process.env.PASSKEYS_ENABLED === '1', needsMigration: ver < SCHEMA_VERSION };
  });

  r.post('/me/password', async ({ req, body }) => {
    const u = await requireUser(req);
    if (isSuper(u)) throw bad('La clave del superadmin se cambia en Vercel (variable SUPERADMIN_PASSWORD).');
    const b = parse(v.object({ current: v.string({ max: 256, trim: false, optional: true }), password: v.string({ min: 1, max: 256, trim: false }) }), body);
    const full = await one('select password_hash from users where id=$1', [u.id]);
    if (full.password_hash && !u.must_change_password) {
      await limitIp(req, 'pwchange', 10, WINDOW, 'Demasiados intentos. Esperá unos minutos.');
      if (!(await verifyPassword(b.current || '', full.password_hash)).ok) throw bad('La clave actual no es correcta');
    }
    checkPasswordPolicy(b.password, u);
    await tx(async () => {
      await q('update users set password_hash=$2, must_change_password=false where id=$1', [u.id, await hashPassword(b.password)]);
      await revokeUserSessions(u.id, req);
    });
    await audit(req, u, 'password_changed', {});
    return { ok: true };
  });

  // ---------- Sesiones propias ----------
  r.get('/me/sessions', async ({ req }) => {
    const u = await requireUser(req);
    return q(`select method, ip, user_agent, created_at, last_seen_at, (id_hash = $2) as current from sessions
      where user_id=$1 and expires_at > now() order by (id_hash = $2) desc, last_seen_at desc limit 50`, [u.id, currentSessionHash(req)]);
  });
  r.post('/me/sessions/revoke-others', async ({ req }) => {
    const u = await requireUser(req);
    const n = await revokeUserSessions(u.id, req);
    await audit(req, u, 'sessions_revoked', { count: n });
    return { ok: true, revoked: n };
  });

  // ---------- Passkeys (WebAuthn / FIDO2) ----------
  r.get('/me/passkeys', async ({ req }) => {
    const u = await requireUser(req);
    return q('select id, name, device_type, backed_up, created_at, last_used_at from webauthn_credentials where user_id=$1 order by created_at', [u.id]);
  });

  /** Registrar una passkey exige un ingreso reciente (una sesión robada no alcanza para dejar una puerta permanente). */
  const requireRecentAuth = async (req) => {
    const u = await requireUser(req);
    if (isSuper(u)) throw bad('El superadmin ingresa solo con la clave definida en Vercel');
    const age = (Date.now() - (req._session?.created_at?.getTime() || 0)) / 60000;
    if (age > RECENT_AUTH_MIN) throw new HttpError(401, 'Por seguridad, volvé a ingresar para agregar una passkey (cerrá sesión y entrá de nuevo).');
    return u;
  };

  // v1.9.5: el ingreso es solo con usuario y clave o con Microsoft. Las passkeys quedan apagadas salvo PASSKEYS_ENABLED=1.
  const passkeysOn = () => process.env.PASSKEYS_ENABLED === '1';
  const requirePasskeys = () => { if (!passkeysOn()) throw new HttpError(403, 'El ingreso con passkey no está habilitado: ingresá con tu usuario y clave o con Microsoft'); };

  r.post('/auth/passkeys/register/options', async ({ req }) => {
    requirePasskeys();
    const u = await requireRecentAuth(req);
    const { rpID, rpName } = rp(req);
    let handle = (await one('select webauthn_user_id from users where id=$1', [u.id]))?.webauthn_user_id;
    if (!handle) {
      handle = crypto.randomBytes(32).toString('base64url');
      await q('update users set webauthn_user_id=$2 where id=$1 and webauthn_user_id is null', [u.id, handle]);
      handle = (await one('select webauthn_user_id from users where id=$1', [u.id])).webauthn_user_id;
    }
    const existing = await q('select id, transports from webauthn_credentials where user_id=$1', [u.id]);
    const options = await generateRegistrationOptions({
      rpName, rpID, userName: u.email, userDisplayName: u.name, userID: Buffer.from(handle, 'base64url'),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      preferredAuthenticatorType: 'localDevice',
    });
    return { challengeId: await saveChallenge(options.challenge, 'register', u.id), options };
  });

  r.post('/auth/passkeys/register/verify', async ({ req, body }) => {
    requirePasskeys();
    const u = await requireRecentAuth(req);
    const b = parse(v.object({ challengeId: v.string({ min: 10, max: 64 }), name: v.string({ max: 60, optional: true }), credential: credentialSchema }), body);
    const ch = await takeChallenge(b.challengeId, 'register');
    if (ch.user_id !== u.id) throw bad('El desafío no corresponde a tu usuario');
    const { origin, rpID } = rp(req);
    let ver;
    try {
      ver = await verifyRegistrationResponse({ response: b.credential, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    } catch (e) {
      throw bad(`No se pudo registrar la passkey: ${e.message}`);
    }
    if (!ver.verified || !ver.registrationInfo) throw bad('No se pudo verificar la passkey');
    const { credential, credentialDeviceType, credentialBackedUp } = ver.registrationInfo;
    await q(`insert into webauthn_credentials(id,user_id,public_key,counter,transports,device_type,backed_up,name) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      credential.id, u.id, Buffer.from(credential.publicKey).toString('base64url'), credential.counter, credential.transports || [],
      credentialDeviceType, credentialBackedUp, b.name || 'Passkey',
    ]);
    await audit(req, u, 'passkey_added', { name: b.name || 'Passkey' });
    return { ok: true };
  });

  r.del('/me/passkeys/:id', async ({ req, params }) => {
    const u = await requireUser(req);
    const row = await one('delete from webauthn_credentials where id=$1 and user_id=$2 returning name', [String(params.id).slice(0, 1024), u.id]);
    if (!row) throw notFound('No existe la passkey');
    await audit(req, u, 'passkey_removed', { name: row.name });
    return { ok: true };
  });

  r.post('/auth/passkeys/login/options', async ({ req }) => {
    requirePasskeys();
    await limitIp(req, 'passkey', 30, WINDOW, 'Demasiados intentos. Esperá unos minutos.');
    const { rpID } = rp(req);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [] });
    return { challengeId: await saveChallenge(options.challenge, 'login'), options };
  });

  r.post('/auth/passkeys/login/verify', async ({ req, body }) => {
    requirePasskeys();
    await limitIp(req, 'passkey', 30, WINDOW, 'Demasiados intentos. Esperá unos minutos.');
    const b = parse(v.object({ challengeId: v.string({ min: 10, max: 64 }), credential: credentialSchema }), body);
    const ch = await takeChallenge(b.challengeId, 'login');
    const cred = await one(`select c.*, u.active, u.role from webauthn_credentials c join users u on u.id=c.user_id where c.id=$1`, [b.credential.id]);
    if (!cred || !cred.active || cred.role === 'superadmin') {
      await audit(req, null, 'login_failed', { passkey: true });
      throw new HttpError(401, 'Esa passkey no está registrada o el usuario está inactivo');
    }
    const { origin, rpID } = rp(req);
    let ver;
    try {
      ver = await verifyAuthenticationResponse({
        response: b.credential, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: cred.id, publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')), counter: Number(cred.counter), transports: cred.transports },
      });
    } catch (e) {
      await audit(req, null, 'login_failed', { passkey: true, error: e.message });
      throw new HttpError(401, 'No se pudo verificar la passkey');
    }
    if (!ver.verified) throw new HttpError(401, 'No se pudo verificar la passkey');
    await q('update webauthn_credentials set counter=$2, last_used_at=now() where id=$1', [cred.id, ver.authenticationInfo.newCounter]);
    const u = await one('select id,name,email from users where id=$1', [cred.user_id]);
    await Promise.all([q('update users set last_login_at=now() where id=$1', [u.id]), audit(req, u, 'login', { passkey: true })]);
    return { ok: true, cookie: await createSession(req, u.id, 'passkey') };
  }, { setCookie: true });

  // ---------- Microsoft (OpenID Connect con PKCE, state y nonce atados al navegador) ----------
  r.get('/auth/ms/start', async ({ req, res, query }) => {
    // ?portal=1: ingreso de empleados al portal (solo ven sus tickets). Usa la misma app y el mismo redirect URI.
    const portal = query.portal === '1';
    const ms = portal ? await portalMicrosoft() : await msLogin();
    if (!ms) throw bad(portal ? 'El ingreso con Microsoft no está habilitado en el portal' : 'El ingreso con Microsoft no está configurado');
    await limitIp(req, 'mslogin', 30, WINDOW);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ms.tenant)) throw bad('Configurá el Tenant ID (GUID) en Microsoft 365 para habilitar el ingreso');
    // El verificador PKCE y el vínculo con el navegador viajan solo en una cookie HttpOnly (nunca en la URL)
    const verifier = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(16).toString('base64url');
    const bind = crypto.randomBytes(16).toString('base64url');
    const state = signToken({ k: 'ms', b: bind, n: nonce, ...(portal ? { p: 1 } : {}) }, 600);
    const params = new URLSearchParams({
      client_id: ms.client, response_type: 'code', redirect_uri: `${appUrl(req)}/api/auth/ms/callback`, response_mode: 'query',
      scope: 'openid profile email', state, nonce, prompt: 'select_account',
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    const secure = !(process.env.PGLITE && !process.env.VERCEL);
    redirect(res, `https://login.microsoftonline.com/${encodeURIComponent(ms.tenant)}/oauth2/v2.0/authorize?${params}`, {
      'Set-Cookie': `hd_oauth=${bind}.${verifier}; Path=/api/auth/ms; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`,
    });
    return undefined;
  }, { raw: true });

  r.get('/auth/ms/callback', async ({ req, res, query }) => {
    const clear = 'hd_oauth=; Path=/api/auth/ms; HttpOnly; SameSite=Lax; Max-Age=0';
    const st = verifyToken(String(query.state || ''));
    const portal = Boolean(st && st.k === 'ms' && st.p === 1);
    const fail = (m) => redirect(res, `${portal ? '/portal#/mis-tickets' : '/#/login'}?error=${encodeURIComponent(String(m).slice(0, 200))}`, { 'Set-Cookie': clear });
    const ms = portal ? await portalMicrosoft() : await msLogin();
    if (!ms) return fail(portal ? 'El ingreso con Microsoft no está habilitado en el portal' : 'Ingreso con Microsoft no configurado');
    const [bindCookie, verifier] = String(parseCookies(req).hd_oauth || '').split('.');
    if (!st || st.k !== 'ms' || !st.b || bindCookie !== st.b || !verifier) return fail('La sesión de ingreso venció o no se inició en este navegador. Probá de nuevo.');
    if (query.error) return fail(query.error_description || query.error);
    let data = {};
    try {
      const tokenRes = await fetchx(`https://login.microsoftonline.com/${encodeURIComponent(ms.tenant)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: ms.client, client_secret: process.env.MS_CLIENT_SECRET, grant_type: 'authorization_code', code: String(query.code || '').slice(0, 4096),
          redirect_uri: `${appUrl(req)}/api/auth/ms/callback`, scope: 'openid profile email', code_verifier: verifier,
        }).toString(),
      }, { service: 'Microsoft Entra ID', timeoutMs: 10000, retries: 0 });
      data = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !data.id_token) return fail(data.error_description?.split('\r\n')[0] || 'Microsoft no devolvió la identidad');
    } catch (e) {
      return fail(e.message);
    }
    let claims;
    try { claims = JSON.parse(Buffer.from(String(data.id_token).split('.')[1], 'base64url').toString('utf8')); } catch { return fail('Identidad inválida'); }
    // El id_token llega directo del endpoint de tokens por TLS; igual se validan audiencia, tenant, nonce y vencimiento.
    // Siempre: audiencia, nonce, vencimiento y que la cuenta sea del tenant de la empresa (tid). Sin esto, una cuenta de
    // otro tenant con el mismo correo podría entrar ("nOAuth").
    if (claims.aud !== ms.client || claims.nonce !== st.n || !claims.exp || claims.exp < Date.now() / 1000
      || String(claims.tid || '').toLowerCase() !== ms.tenant.toLowerCase() || !claims.oid) return fail('La identidad de Microsoft no es válida para esta aplicación');
    // Se usa el nombre de usuario de la cuenta del tenant (no el atributo "email", que se puede editar)
    const email = String(claims.preferred_username || claims.upn || claims.email || '').toLowerCase().slice(0, 254);
    // Portal: cualquier cuenta del tenant de la empresa. No crea agentes ni da acceso a la mesa: solo sus tickets.
    if (portal) {
      // Solo miembros de la empresa: las cuentas invitadas (B2B) traen un correo que no administra la empresa
      if (isGuestAccount(claims, ms.tenant)) {
        await audit(req, null, 'login_failed', { login: email, microsoft: true, portal: true, guest: true });
        return fail('Las cuentas invitadas no pueden ingresar al portal. Use el número de ticket y su correo para consultarlo.');
      }
      const emails = sessionEmails(claims);
      if (!emails.length) return fail('Tu cuenta de Microsoft no tiene un correo asociado');
      await audit(req, null, 'portal_login', { login: emails[0], microsoft: true });
      const name = String(claims.name || emails[0].split('@')[0]).slice(0, 120);
      res.setHeader('Set-Cookie', [await createPortalSession(req, { oid: claims.oid, emails, name }), clear]);
      redirect(res, '/portal#/mis-tickets');
      return undefined;
    }
    if (ms.login.required_group) {
      let member = false;
      try { member = await userInGroup(email, ms.login.required_group); } catch (e) {
        await m365Log('login', `No se pudo validar el grupo de ${email}: ${e.message}`, {}, 'error');
        return fail('No se pudo validar tu grupo en Microsoft 365. Avisá al administrador.');
      }
      if (!member) {
        await audit(req, null, 'login_failed', { login: email, microsoft: true, group: false });
        return fail(`La cuenta ${email} no pertenece al grupo "${ms.login.required_group}"`);
      }
      if (ms.login.auto_create_agents) {
        await q(`insert into users(name,email,role,active) values ($1,$2,'agent',true) on conflict (email) do nothing`, [String(claims.name || email.split('@')[0]).slice(0, 120), email]);
      }
    }
    // El usuario se reconoce por el identificador inmutable de Entra (oid). La primera vez se vincula por correo.
    const u = await one(`select id,name,email,active,external_id from users where role<>'superadmin' and (external_id=$1 or (external_id is null and email=$2)) order by (external_id=$1) desc limit 1`, [claims.oid, email]);
    if (!u || !u.active) {
      await audit(req, null, 'login_failed', { login: email, microsoft: true });
      return fail(`La cuenta ${email} no está habilitada como agente`);
    }
    await Promise.all([
      audit(req, u, 'login', { microsoft: true }),
      q('update users set last_login_at=now(), external_id=coalesce(external_id,$2) where id=$1', [u.id, claims.oid]),
    ]);
    res.setHeader('Set-Cookie', [await createSession(req, u.id, 'microsoft'), clear]);
    redirect(res, '/#/');
    return undefined;
  }, { raw: true });
}

