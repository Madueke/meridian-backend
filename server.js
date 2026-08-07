// Meridian Trading Co-Pilot backend.
// TRADING MODE: this server is the only place trade execution may happen.
// It never performs on-screen automation; it talks to brokers via
// server-side integrations (MT5 backend, Claude API) only.

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

// Initialize and start alarm scheduler
const { startAlarmScheduler, stopAlarmScheduler } = require('./lib/alarms');
const alarmTimer = startAlarmScheduler();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, shutting down...');
  stopAlarmScheduler(alarmTimer);
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[server] SIGINT received, shutting down...');
  stopAlarmScheduler(alarmTimer);
  process.exit(0);
});

const app = express();

const { requireAuth } = require('./lib/require-auth');

// Security headers (CSP, X-Content-Type-Options, etc.)
app.use(helmet());

// Restrict CORS to the app's origin. The Flutter app itself is not a
// browser, so this mostly matters for any future web dashboard; the
// allowlist is overridable via CORS_ORIGIN (comma-separated).
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser clients (no Origin header), wildcard (*), and
      // allowlisted origins.
      const isWildcard = allowedOrigins.includes('*');
      if (!origin || isWildcard || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
  }),
);

app.use(express.json({ limit: '10mb' }));

// --- Endpoints ---
app.use('/auth', require('./routes/auth'));
app.use('/chat', require('./routes/chat'));
app.use('/analyze', requireAuth, require('./routes/analyze'));
app.use('/journal', requireAuth, require('./routes/journal'));
app.use('/risk-status', requireAuth, require('./routes/risk'));
app.use('/execute-trade-signal', requireAuth, require('./routes/execute'));
app.use('/strategy', requireAuth, require('./routes/strategy'));
app.use('/backtest', requireAuth, require('./routes/backtest'));
app.use('/train', requireAuth, require('./routes/train'));
app.use('/config', requireAuth, require('./routes/config'));
app.use('/agent', requireAuth, require('./routes/agent'));
app.use('/admin', require('./routes/admin'));
app.use('/settings', requireAuth, require('./routes/settings'));
const market = require('./routes/market');
app.use('/quote', market.quoteRouter);
app.use('/chart', market.chartRouter);
app.use('/', require('./routes/connect'));
app.use('/notifications', require('./routes/notifications'));

// Android passkey association: the app package + APK signing SHA-256 must be
// discoverable at https://<WEBAUTHN_RP_ID>/.well-known/assetlinks.json for
// Android Credential Manager to allow passkeys for this RP. Configure
// ANDROID_PACKAGE_NAME / ANDROID_CERT_SHA256 in .env; without them the route
// is skipped and passkeys only work in browsers.
if (process.env.ANDROID_PACKAGE_NAME && process.env.ANDROID_CERT_SHA256) {
  app.get('/.well-known/assetlinks.json', (req, res) => {
    res.json([
      {
        relation: ['delegate_permission/common.get_login_creds'],
        target: {
          namespace: 'web',
          site: `https://${process.env.WEBAUTHN_RP_ID || 'localhost'}`,
        },
      },
      {
        relation: ['delegate_permission/common.get_login_creds'],
        target: {
          namespace: 'android_app',
          package_name: process.env.ANDROID_PACKAGE_NAME,
          sha256_cert_fingerprints: [
            process.env.ANDROID_CERT_SHA256.toLowerCase().replace(/:/g, ''),
          ],
        },
      },
    ]);
  });
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error handler
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-unused-vars
  void next;
  if (err.message && err.message.startsWith('Origin')) {
    return res.status(403).json({ error: err.message });
  }
  // Explicit 4xx from route handlers (e.g. lib/auth.js status=400 errors).
  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  // @simplewebauthn/server verification failures are client errors (bad
  // credential, wrong challenge, wrong origin, etc.) — never 500s.
  if (err && err.constructor && err.constructor.name === 'WebAuthnError') {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Meridian backend listening on port ${PORT}`);
});
