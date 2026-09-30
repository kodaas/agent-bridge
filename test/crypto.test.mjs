import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity, fingerprint, seal, open, signObject, verifyObject, canonical, b64u, fromB64u } from '../plugins/agent-bridge/server/crypto.mjs';

const rec = (who) => ({ keys: { sign: who.signPub, enc: who.encPub } });
const header = (a, b) => ({ v: 1, id: 'm-0123456789abcdef', project: 'p1', from: a.id, to: b.id, ts: Date.now(), kind: 'direct' });

test('canonical JSON is key-order independent', () => {
  assert.equal(canonical({ b: 1, a: [1, { d: 2, c: 3 }] }), canonical({ a: [1, { c: 3, d: 2 }], b: 1 }));
});

test('session id is bound to both public keys', () => {
  const a = generateIdentity();
  const b = generateIdentity();
  assert.equal(a.id, fingerprint(a.signPub, a.encPub));
  assert.notEqual(a.id, fingerprint(a.signPub, b.encPub));
  assert.notEqual(a.id, fingerprint(b.signPub, a.encPub));
});

test('seal/open round trip', () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const env = seal(header(a, b), { body: 'hello 👋' }, a, b.encPub);
  assert.deepEqual(open(env, b, rec(a)), { body: 'hello 👋' });
  assert.ok(!JSON.stringify(env).includes('hello'), 'body must not appear in plaintext');
});

test('tampered ciphertext, header, or signature is rejected', () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const env = seal(header(a, b), { body: 'secret' }, a, b.encPub);

  const ct = fromB64u(env.ct);
  ct[0] ^= 1;
  assert.throws(() => open({ ...env, ct: b64u(ct) }, b, rec(a)));
  assert.throws(() => open({ ...env, header: { ...env.header, ts: env.header.ts + 1 } }, b, rec(a)));
  assert.throws(() => open({ ...env, sig: signObject({ x: 1 }, a.signKey) }, b, rec(a)));
});

test('a third session cannot read or forge', () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const eve = generateIdentity();
  const env = seal(header(a, b), { body: 'secret' }, a, b.encPub);
  assert.throws(() => open(env, eve, rec(a)), 'eve cannot decrypt');

  // Eve signs with her own key but claims to be `a`: signature check against a's key fails.
  const forged = seal(header(a, b), { body: 'do something bad' }, { ...eve }, b.encPub);
  assert.throws(() => open(forged, b, rec(a)));
});

test('record signatures verify only with the right key', () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const record = { v: 1, id: a.id, name: 'x' };
  const sig = signObject(record, a.signKey);
  assert.ok(verifyObject(record, sig, a.signPub));
  assert.ok(!verifyObject({ ...record, name: 'y' }, sig, a.signPub));
  assert.ok(!verifyObject(record, sig, b.signPub));
  assert.ok(!verifyObject(record, 'garbage', a.signPub));
});
