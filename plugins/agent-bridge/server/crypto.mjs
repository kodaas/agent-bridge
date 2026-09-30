// Session identity and message sealing, built only on node:crypto.
//
// Each session holds two in-memory key pairs that never touch disk:
//   - Ed25519 (signing): proves which session wrote a record or message
//   - X25519  (encryption): derives per-direction AES-256-GCM keys with peers
// A session's id is a fingerprint of both public keys, so an id cannot be
// claimed without holding the matching private keys.

import crypto from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64u = (s) => Buffer.from(String(s), 'base64url');

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function fingerprint(signPub, encPub) {
  return crypto
    .createHash('sha256')
    .update(`agent-bridge/v1/id\0${signPub}\0${encPub}`)
    .digest('hex')
    .slice(0, 16);
}

export function generateIdentity() {
  const sign = crypto.generateKeyPairSync('ed25519');
  const enc = crypto.generateKeyPairSync('x25519');
  const signPub = sign.publicKey.export({ format: 'jwk' }).x;
  const encPub = enc.publicKey.export({ format: 'jwk' }).x;
  return { id: fingerprint(signPub, encPub), signPub, encPub, signKey: sign.privateKey, encKey: enc.privateKey };
}

function publicKey(x, crv) {
  if (typeof x !== 'string' || fromB64u(x).length !== 32) throw new Error('malformed public key');
  return crypto.createPublicKey({ key: { kty: 'OKP', crv, x }, format: 'jwk' });
}

export function signObject(obj, signKey) {
  return b64u(crypto.sign(null, Buffer.from(canonical(obj)), signKey));
}

export function verifyObject(obj, sig, signPub) {
  try {
    return crypto.verify(null, Buffer.from(canonical(obj)), publicKey(signPub, 'Ed25519'), fromB64u(sig));
  } catch {
    return false;
  }
}

function messageKey(myEncKey, peerEncPub, header) {
  const shared = crypto.diffieHellman({ privateKey: myEncKey, publicKey: publicKey(peerEncPub, 'X25519') });
  if (shared.every((b) => b === 0)) throw new Error('degenerate key exchange');
  const salt = Buffer.from(`agent-bridge/v1/${header.project}`);
  const info = Buffer.from(`msg|${header.from}|${header.to}`);
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, info, 32));
}

// Encrypt `payload` for one recipient. The plaintext header is bound as AAD and
// the whole envelope is signed by the sender.
export function seal(header, payload, sender, recipientEncPub) {
  const key = messageKey(sender.encKey, recipientEncPub, header);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(canonical(header)));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const envelope = { header, nonce: b64u(nonce), ct: b64u(ct) };
  return { ...envelope, sig: signObject(envelope, sender.signKey) };
}

// Verify the sender's signature and decrypt. Throws on any failure.
export function open(envelope, recipient, senderRecord) {
  const { header, nonce, ct, sig } = envelope;
  if (!verifyObject({ header, nonce, ct }, sig, senderRecord.keys.sign)) throw new Error('bad signature');
  const key = messageKey(recipient.encKey, senderRecord.keys.enc, header);
  const raw = fromB64u(ct);
  if (raw.length < 17) throw new Error('ciphertext too short');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, fromB64u(nonce));
  decipher.setAAD(Buffer.from(canonical(header)));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const pt = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}
