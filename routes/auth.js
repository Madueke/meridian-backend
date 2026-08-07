// routes/auth.js — sign up / sign in / passkey / session endpoints.
//
//   POST /auth/signup    { email, display_name, device_secret? } → { user_id, session_token }
//   POST /auth/signin    { email } → { user_id, has_passkey, has_device_secret, display_name }
//   POST /auth/device/verify { email, device_secret } → { session_token, ... }
//   POST /auth/passkey/register/begin    (session) → WebAuthn creation options
//   POST /auth/passkey/register/complete (session) { public_key_credential }
//   POST /auth/passkey/verify/begin      { user_id } → WebAuthn request options
//   POST /auth/passkey/verify/complete   { user_id, signed_challenge }
//                                        → { session_token, user_id, ... }
//   POST /auth/logout    { session_token }
//   GET  /auth/session   ?session_token=... → { valid, user_id, email, ... }
//
// Passkeys are the primary credential over HTTPS. On plain-HTTP / IP-address
// deployments WebAuthn cannot run, so the app uses a device-bound secret
// instead (see lib/auth.js). Email sign-in alone never issues a session; it
// starts the passkey ceremony or the device-bound verify.

const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const { requireAuth } = require('../lib/require-auth');

// POST /auth/signup — create the account and open a session immediately so
// the app can run the passkey registration ceremony (or bind its device
// secret) right away.
router.post('/signup', (req, res) => {
  const { email, display_name, device_secret } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  if (auth.getUserByEmail(email)) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }
  const user = auth.createUser(email, display_name);
  if (
    device_secret &&
    typeof device_secret === 'string' &&
    device_secret.length >= 16
  ) {
    auth.setDeviceSecret(user.user_id, device_secret);
  }
  const sessionToken = auth.createSession(user.user_id);
  res.json({
    user_id: user.user_id,
    display_name: user.display_name,
    email: user.email,
    session_token: sessionToken,
  });
});

// POST /auth/signin — resolve the account, never issue a session on its own.
router.post('/signin', (req, res) => {
  const { email } = req.body || {};
  const user = auth.getUserByEmail(email);
  if (!user) {
    return res.status(404).json({ error: 'No account found for this email' });
  }
  res.json({
    user_id: user.user_id,
    display_name: user.display_name,
    has_passkey: user.passkey_registered,
    has_device_secret: auth.hasDeviceSecret(user.user_id),
  });
});

// POST /auth/device/verify — device-bound sign-in for deployments where
// passkeys cannot run (plain HTTP / IP address). Issues a session when the
// secret matches. A credential-less account (no passkey, no device secret —
// e.g. created before device binding existed) is bound to the calling device
// on first verify so existing accounts are not bricked.
router.post('/device/verify', (req, res) => {
  const { email, device_secret } = req.body || {};
  if (!email || !device_secret || typeof device_secret !== 'string') {
    return res
      .status(400)
      .json({ error: 'email and device_secret are required' });
  }
  const user = auth.getUserByEmail(email);
  if (!user) {
    return res.status(404).json({ error: 'No account found for this email' });
  }
  const canBind = !user.passkey_registered && !auth.hasDeviceSecret(user.user_id);
  if (canBind) {
    auth.setDeviceSecret(user.user_id, device_secret);
  } else if (!auth.verifyDeviceSecret(user.user_id, device_secret)) {
    return res.status(403).json({
      error:
        'Device sign-in failed: this account is already linked to another device.',
    });
  }
  const sessionToken = auth.createSession(user.user_id);
  res.json({
    user_id: user.user_id,
    display_name: user.display_name,
    email: user.email,
    session_token: sessionToken,
    device_bound: canBind,
  });
});

// POST /auth/passkey/register/begin — creation options for a new passkey.
router.post('/passkey/register/begin', requireAuth, async (req, res, next) => {
  try {
    const user = auth.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const options = await auth.startRegistration(user);
    // Android Credential Manager requires user.id to be base64url WITH
    // padding; simplewebauthn emits it unpadded. Pad before sending.
    if (options.user && typeof options.user.id === 'string') {
      const padded = options.user.id + '='.repeat((4 - (options.user.id.length % 4)) % 4);
      options.user.id = padded;
    }
    res.json(options);
  } catch (err) {
    next(err);
  }
});

// POST /auth/passkey/register/complete — verify and store the new passkey.
router.post('/passkey/register/complete', requireAuth, async (req, res, next) => {
  try {
    const { public_key_credential } = req.body || {};
    if (!public_key_credential || typeof public_key_credential !== 'object') {
      return res.status(400).json({ error: 'public_key_credential is required' });
    }
    await auth.finishRegistration(req.userId, public_key_credential);
    res.json({ status: 'ok', passkey_registered: true });
  } catch (err) {
    next(err);
  }
});

// POST /auth/passkey/verify/begin — request options for sign-in.
router.post('/passkey/verify/begin', async (req, res, next) => {
  try {
    const { user_id } = req.body || {};
    const user = auth.getUserById(user_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.passkey_registered) {
      return res.status(400).json({ error: 'No passkey registered for this user' });
    }
    const options = await auth.startAuthentication(user);
    res.json(options);
  } catch (err) {
    next(err);
  }
});

// POST /auth/passkey/verify/complete — verify the signed challenge and issue
// a fresh session token.
router.post('/passkey/verify/complete', async (req, res, next) => {
  try {
    const { user_id, signed_challenge } = req.body || {};
    if (!user_id || !signed_challenge || typeof signed_challenge !== 'object') {
      return res
        .status(400)
        .json({ error: 'user_id and signed_challenge are required' });
    }
    const user = auth.getUserById(user_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await auth.finishAuthentication(user_id, signed_challenge);
    const sessionToken = auth.createSession(user_id);
    res.json({
      user_id,
      display_name: user.display_name,
      email: user.email,
      session_token: sessionToken,
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout — revoke the session.
router.post('/logout', (req, res) => {
  const { session_token } = req.body || {};
  auth.deleteSession(session_token);
  res.json({ status: 'ok' });
});

// GET /auth/session — validity check used on app launch / PIN fast path.
router.get('/session', (req, res) => {
  const { session_token } = req.query;
  const session = auth.resolveSession(session_token);
  if (!session) return res.json({ valid: false });
  const user = auth.getUserById(session.user_id);
  res.json({
    valid: true,
    user_id: session.user_id,
    email: user ? user.email : null,
    display_name: user ? user.display_name : null,
    passkey_registered: user ? user.passkey_registered : false,
  });
});

module.exports = router;
