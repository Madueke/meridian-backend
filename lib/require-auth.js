// lib/require-auth.js — Express middleware resolving the authenticated user
// from a session token. Accepts `Authorization: Bearer <token>` or a
// `session_token` body/query field. On success sets req.userId; otherwise
// responds 401 and does not continue.

const auth = require('./auth');

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const body = req.body || {};
  if (typeof body.session_token === 'string' && body.session_token) {
    return body.session_token;
  }
  const query = req.query || {};
  if (typeof query.session_token === 'string' && query.session_token) {
    return query.session_token;
  }
  return null;
}

function requireAuth(req, res, next) {
  const session = auth.resolveSession(extractToken(req));
  if (!session) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.userId = session.user_id;
  return next();
}

module.exports = { requireAuth };
