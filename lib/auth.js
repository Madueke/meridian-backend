// lib/auth.js — users, sessions and passkey (WebAuthn) management.
//
// Sessions are opaque random tokens stored server-side with an expiry; the
// app keeps them in secure storage and sends them as `Authorization: Bearer`
// on every Trading Mode call. The backend resolves a token to a user_id, so
// the app never needs to send a raw user_id.
//
// Passkeys use @simplewebauthn/server against Android Credential Manager
// (origin `android:apk-key-hash:...`) and standard browser flows. The relying
// party id/origin come from env; see WEBAUTHN_* in .env.

const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const store = require('./store');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const rpName = process.env.WEBAUTHN_RP_NAME || 'Neutral Pip';
const rpID = process.env.WEBAUTHN_RP_ID || 'localhost';
// Origins accepted for WebAuthn responses: the configured https origin plus
// any Android Credential Manager origin (which encodes the APK signing key).
const rpOrigins = (process.env.WEBAUTHN_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function expectedOrigins() {
  const origins = rpOrigins.length > 0 ? rpOrigins : ['http://localhost:3000'];
  origins.push(/^android:apk-key-hash:/);
  return origins;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function createUser(email, displayName) {
  const user = {
    user_id: crypto.randomUUID(),
    email: normalizeEmail(email),
    display_name: String(displayName || '').trim() || 'Trader',
    passkeys: [],
    passkey_registered: false,
    created_at: new Date().toISOString(),
  };
  store.set('users', user.user_id, user);
  store.set('users_by_email', user.email, user.user_id);
  return user;
}

function getUserByEmail(email) {
  const userId = store.get('users_by_email', normalizeEmail(email));
  if (!userId) return null;
  return store.get('users', userId);
}

function getUserById(userId) {
  return store.get('users', userId);
}

function addPasskey(userId, credential) {
  const user = getUserById(userId);
  if (!user) return false;
  user.passkeys = user.passkeys || [];
  user.passkeys.push({
    id: credential.id,
    public_key: Buffer.from(credential.publicKey).toString('base64'),
    counter: credential.counter,
    transports: credential.transports || [],
    created_at: new Date().toISOString(),
  });
  user.passkey_registered = true;
  store.set('users', userId, user);
  return true;
}

function getPasskey(userId, credentialId) {
  const user = getUserById(userId);
  if (!user) return null;
  return (user.passkeys || []).find((pk) => pk.id === credentialId) || null;
}

function updatePasskeyCounter(userId, credentialId, counter) {
  const user = getUserById(userId);
  if (!user) return;
  user.passkeys = (user.passkeys || []).map((pk) =>
    pk.id === credentialId ? { ...pk, counter } : pk,
  );
  store.set('users', userId, user);
}

function userPasskeyCredentials(userId) {
  const user = getUserById(userId);
  return (user?.passkeys || []).map((pk) => ({
    id: pk.id,
    type: 'public-key',
    transports: pk.transports,
  }));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  store.set('sessions', token, {
    user_id: userId,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  return token;
}

function resolveSession(token) {
  if (!token) return null;
  const session = store.get('sessions', token);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    store.remove('sessions', token);
    return null;
  }
  return session;
}

function deleteSession(token) {
  if (token) store.remove('sessions', token);
}

function deleteAllUserSessions(userId) {
  for (const token of store.keys('sessions') || []) {
    const session = store.get('sessions', token);
    if (session && session.user_id === userId) store.remove('sessions', token);
  }
}

// ---------------------------------------------------------------------------
// WebAuthn challenges (single in-flight challenge per user)
// ---------------------------------------------------------------------------

function saveChallenge(userId, kind, challenge) {
  store.set('challenges', userId, {
    kind,
    challenge,
    created_at: Date.now(),
  });
}

function consumeChallenge(userId, kind) {
  const entry = store.get('challenges', userId);
  if (!entry || entry.kind !== kind) return null;
  if (Date.now() - entry.created_at > CHALLENGE_TTL_MS) {
    store.remove('challenges', userId);
    return null;
  }
  store.remove('challenges', userId);
  return entry.challenge;
}

// Peek at a challenge without consuming it, so a failed verification attempt
// does not invalidate an in-flight ceremony. Cleared via clearChallenge on
// success (or overwritten by the next begin).
function peekChallenge(userId, kind) {
  const entry = store.get('challenges', userId);
  if (!entry || entry.kind !== kind) return null;
  if (Date.now() - entry.created_at > CHALLENGE_TTL_MS) {
    store.remove('challenges', userId);
    return null;
  }
  return entry.challenge;
}

function clearChallenge(userId, kind) {
  const entry = store.get('challenges', userId);
  if (entry && entry.kind === kind) store.remove('challenges', userId);
}

// ---------------------------------------------------------------------------
// WebAuthn ceremony helpers
// ---------------------------------------------------------------------------

async function startRegistration(user) {
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.email,
    userDisplayName: user.display_name,
    userID: Buffer.from(user.user_id),
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
    excludeCredentials: userPasskeyCredentials(user.user_id),
    timeout: 60000,
  });
  saveChallenge(user.user_id, 'register', options.challenge);
  return options;
}

async function finishRegistration(userId, publicKeyCredential) {
  const expectedChallenge = peekChallenge(userId, 'register');
  if (!expectedChallenge) {
    const err = new Error('No pending passkey registration challenge');
    err.status = 400;
    throw err;
  }
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: publicKeyCredential,
      expectedChallenge,
      expectedOrigin: expectedOrigins(),
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    // Any malformed credential or verification failure is a client error.
    const wrapped = new Error(err && err.message ? err.message : 'Passkey registration verification failed');
    wrapped.status = 400;
    throw wrapped;
  }
  if (!verification.verified || !verification.registrationInfo) {
    const err = new Error('Passkey registration verification failed');
    err.status = 400;
    throw err;
  }
  const { credential } = verification.registrationInfo;
  addPasskey(userId, {
    id: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: publicKeyCredential.response.transports || [],
  });
  clearChallenge(userId, 'register');
  return verification;
}

async function startAuthentication(user) {
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: userPasskeyCredentials(user.user_id),
    userVerification: 'preferred',
    timeout: 60000,
  });
  saveChallenge(user.user_id, 'authenticate', options.challenge);
  return options;
}

async function finishAuthentication(userId, publicKeyCredential) {
  const expectedChallenge = peekChallenge(userId, 'authenticate');
  if (!expectedChallenge) {
    const err = new Error('No pending passkey authentication challenge');
    err.status = 400;
    throw err;
  }
  const credential = getPasskey(userId, publicKeyCredential.id);
  if (!credential) {
    const err = new Error('Unknown passkey for this user');
    err.status = 400;
    throw err;
  }
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: publicKeyCredential,
      expectedChallenge,
      expectedOrigin: expectedOrigins(),
      expectedRPID: rpID,
      credential: {
        id: credential.id,
        publicKey: Buffer.from(credential.public_key, 'base64'),
        counter: credential.counter,
      },
      requireUserVerification: false,
    });
  } catch (err) {
    // Any malformed credential or verification failure is a client error.
    const wrapped = new Error(err && err.message ? err.message : 'Passkey authentication verification failed');
    wrapped.status = 400;
    throw wrapped;
  }
  if (!verification.verified) {
    const err = new Error('Passkey authentication verification failed');
    err.status = 400;
    throw err;
  }
  updatePasskeyCounter(userId, credential.id, verification.authenticationInfo.newCounter);
  clearChallenge(userId, 'authenticate');
  return verification;
}

module.exports = {
  rpID,
  rpName,
  normalizeEmail,
  createUser,
  getUserByEmail,
  getUserById,
  addPasskey,
  createSession,
  resolveSession,
  deleteSession,
  deleteAllUserSessions,
  startRegistration,
  finishRegistration,
  startAuthentication,
  finishAuthentication,
};
