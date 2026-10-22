// Passkeys (WebAuthn): conversión entre el JSON del servidor y las APIs del navegador.
const b64uToBuf = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
};
const bufToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const passkeysSupported = () => Boolean(window.PublicKeyCredential && navigator.credentials?.create);

/** Crea una passkey con las opciones de registro del servidor y devuelve la respuesta en JSON. */
export async function createPasskey(options) {
  const publicKey = {
    ...options,
    challenge: b64uToBuf(options.challenge),
    user: { ...options.user, id: b64uToBuf(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  };
  const cred = await navigator.credentials.create({ publicKey });
  const r = cred.response;
  return {
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || null,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    response: {
      clientDataJSON: bufToB64u(r.clientDataJSON),
      attestationObject: bufToB64u(r.attestationObject),
      transports: r.getTransports ? r.getTransports() : [],
    },
  };
}

/** Firma el desafío de ingreso con una passkey del dispositivo. */
export async function getPasskey(options) {
  const publicKey = {
    ...options,
    challenge: b64uToBuf(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  };
  const cred = await navigator.credentials.get({ publicKey, mediation: 'optional' });
  const r = cred.response;
  return {
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || null,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    response: {
      clientDataJSON: bufToB64u(r.clientDataJSON),
      authenticatorData: bufToB64u(r.authenticatorData),
      signature: bufToB64u(r.signature),
      userHandle: r.userHandle ? bufToB64u(r.userHandle) : undefined,
    },
  };
}
