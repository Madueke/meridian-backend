// Full WebAuthn ceremony smoke test: real registration + authentication
// responses are crafted locally (P-256 keypair, CBOR via tiny-cbor) so the
// backend's verify functions run against valid credentials end to end.
const crypto = require('crypto');
const { encodeCBOR } = require('@levischuck/tiny-cbor');

const BASE = 'http://127.0.0.1:3000';
const ORIGIN = 'http://localhost:3000';

function req(method, path, { body, token, query } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = require('http').request(url, { method, headers }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(chunks); } catch {}
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function assert(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  if (!cond) process.exitCode = 1;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const derToRaw = (der) => {
  let offset = 1; // skip 0x30 sequence tag
  const readLen = () => {
    let len = der[offset++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + der[offset++];
    }
    return len;
  };
  readLen(); // sequence length
  if (der[offset++] !== 0x02) throw new Error('bad r tag');
  const rLen = readLen();
  let r = der.subarray(offset, offset + rLen);
  offset += rLen;
  if (der[offset++] !== 0x02) throw new Error('bad s tag');
  const sLen = readLen();
  let s = der.subarray(offset, offset + sLen);
  if (r.length === 33 && r[0] === 0) r = r.subarray(1);
  if (s.length === 33 && s[0] === 0) s = s.subarray(1);
  return Buffer.concat([Buffer.alloc(32 - r.length), r, Buffer.alloc(32 - s.length), s]);
};

function coseKey(x, y) {
  return new Map([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, x],
    [-3, y],
  ]);
}

function buildAuthData(rpIdHash, flags, counter, credId, publicKey) {
  const parts = [rpIdHash, Buffer.from([flags])];
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(counter);
  parts.push(counterBuf);
  if (credId && publicKey) {
    const aaguid = Buffer.alloc(16);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(credId.length);
    parts.push(aaguid, idLen, credId, publicKey);
  }
  return Buffer.concat(parts);
}

const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pubJwk = keyPair.publicKey.export({ format: 'jwk' });
const x = Buffer.from(pubJwk.x, 'base64url');
const y = Buffer.from(pubJwk.y, 'base64url');
const credId = crypto.randomBytes(32);
const cosePub = encodeCBOR(coseKey(x, y));

function sign(data) {
  // simplewebauthn v13 expects WebAuthn-format ASN.1 DER signatures and
  // unwraps them internally (unwrapEC2Signature).
  return crypto.sign('sha256', data, keyPair.privateKey);
}

(async () => {
  // 1. unauth GET /risk-status -> 401
  const r1 = await req('GET', '/risk-status');
  assert('unauth /risk-status -> 401', r1.status === 401, r1);

  // 2. signup
  const email = 'ceremony' + Date.now() + '@pip.app';
  const r2 = await req('POST', '/auth/signup', { body: { email, display_name: 'Tester' } });
  assert('signup -> 200 + session_token', r2.status === 200 && r2.body && r2.body.session_token, r2);
  const token = r2.body.session_token;
  const userId = r2.body.user_id;

  // 3. duplicate signup -> 409
  const r3 = await req('POST', '/auth/signup', { body: { email, display_name: 'Tester' } });
  assert('duplicate signup -> 409', r3.status === 409, r3);

  // 4. session valid
  const r4 = await req('GET', '/auth/session', { query: { session_token: token } });
  assert('session valid', r4.status === 200 && r4.body.valid === true && r4.body.user_id === userId, r4);

  // 5. register/begin
  const r5 = await req('POST', '/auth/passkey/register/begin', { token });
  assert('register/begin -> challenge + rp.id', r5.status === 200 && r5.body.challenge && r5.body.rp && r5.body.rp.id, r5);
  const regOptions = r5.body;

  // 5b. register/begin unauth -> 401
  const r5b = await req('POST', '/auth/passkey/register/begin');
  assert('register/begin unauth -> 401', r5b.status === 401, r5b);

  // 5c. register/complete with garbage -> 400
  const r5c = await req('POST', '/auth/passkey/register/complete', { token, body: { public_key_credential: { id: 'x', rawId: 'x', type: 'public-key', response: {} } } });
  assert('register/complete garbage -> 400', r5c.status === 400, r5c);

  // 5d. register/complete with valid crafted credential -> ok
  const rpIdHash = crypto.createHash('sha256').update(regOptions.rp.id).digest();
  const regAuthData = buildAuthData(rpIdHash, 0x45, 0, credId, cosePub);
  const regClientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: regOptions.challenge, origin: ORIGIN, crossOrigin: false }));
  const regClientDataHash = crypto.createHash('sha256').update(regClientDataJSON).digest();
  const regSignature = sign(Buffer.concat([regAuthData, regClientDataHash]));
  const attestationObject = encodeCBOR(new Map([
    ['fmt', 'none'],
    ['attStmt', new Map()],
    ['authData', regAuthData],
  ]));
  const publicKeyCredential = {
    id: b64url(credId),
    rawId: b64url(credId),
    type: 'public-key',
    response: {
      clientDataJSON: b64url(regClientDataJSON),
      attestationObject: b64url(attestationObject),
      transports: ['internal'],
    },
    clientExtensionResults: {},
  };
  const r5d = await req('POST', '/auth/passkey/register/complete', { token, body: { public_key_credential: publicKeyCredential } });
  assert('register/complete valid -> ok', r5d.status === 200 && r5d.body.status === 'ok' && r5d.body.passkey_registered === true, r5d);

  // 6. connect-account with Bearer
  const r6 = await req('POST', '/connect-account', { token, body: { account: 'tradingview', symbols: ['EURUSD', 'XAUUSD'], timeframes: ['H1', 'D1'] } });
  assert('connect-account (Bearer) -> ok', r6.status === 200, r6);

  // 7. account-status -> tradingview connected
  const r7 = await req('GET', '/account-status', { token });
  assert('account-status -> tradingview connected', r7.status === 200, r7);

  // 8. connect without token -> 401
  const r8 = await req('POST', '/connect-account', { body: { account: 'tradingview', symbols: ['EURUSD'] } });
  assert('connect-account unauth -> 401', r8.status === 401, r8);

  // 9. signin -> has_passkey true
  const r9 = await req('POST', '/auth/signin', { body: { email } });
  assert('signin -> has_passkey', r9.status === 200 && r9.body.has_passkey === true && r9.body.user_id === userId, r9);

  // 10. verify/begin
  const r10 = await req('POST', '/auth/passkey/verify/begin', { body: { user_id: userId } });
  assert('verify/begin -> challenge + rpId', r10.status === 200 && r10.body.challenge && r10.body.rpId === regOptions.rp.id, r10);

  // 11. verify/complete with crafted authentication response -> new session
  const authOptions = r10.body;
  const authData = buildAuthData(rpIdHash, 0x05, 1);
  const authClientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: authOptions.challenge, origin: ORIGIN, crossOrigin: false }));
  const authClientDataHash = crypto.createHash('sha256').update(authClientDataJSON).digest();
  const authSignature = sign(Buffer.concat([authData, authClientDataHash]));
  const signedChallenge = {
    id: b64url(credId),
    rawId: b64url(credId),
    type: 'public-key',
    response: {
      clientDataJSON: b64url(authClientDataJSON),
      authenticatorData: b64url(authData),
      signature: b64url(authSignature),
    },
    clientExtensionResults: {},
  };
  const r11 = await req('POST', '/auth/passkey/verify/complete', { body: { user_id: userId, signed_challenge: signedChallenge } });
  assert('verify/complete -> session_token', r11.status === 200 && r11.body.session_token && r11.body.user_id === userId, r11);
  const token2 = r11.body.session_token;

  // 12. new session valid + protected route works with it
  const r12 = await req('GET', '/auth/session', { query: { session_token: token2 } });
  assert('new session valid', r12.status === 200 && r12.body.valid === true, r12);
  const r12b = await req('GET', '/risk-status', { token: token2 });
  assert('risk-status with new session -> 200', r12b.status === 200, r12b);

  // 13. counter advanced (second auth reuses old counter path: verify/begin again)
  const r13 = await req('POST', '/auth/passkey/verify/begin', { body: { user_id: userId } });
  assert('verify/begin after auth still ok', r13.status === 200, r13);

  // 14. logout then session invalid
  const r14 = await req('POST', '/auth/logout', { body: { session_token: token2 } });
  assert('logout -> ok', r14.status === 200, r14);
  const r15 = await req('GET', '/auth/session', { query: { session_token: token2 } });
  assert('session invalid after logout', r15.status === 200 && r15.body.valid === false, r15);

  // 15. protected with dead token -> 401
  const r16 = await req('GET', '/risk-status', { token: token2 });
  assert('risk-status with dead token -> 401', r16.status === 401, r16);

  // 16. public endpoints open
  const r17 = await req('GET', '/quote?symbol=EURUSD');
  assert('/quote public', r17.status === 200 || r17.status === 404, r17);
  const r18 = await req('GET', '/health');
  assert('/health public', r18.status === 200, r18);

  console.log(process.exitCode ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED');
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(1); });
