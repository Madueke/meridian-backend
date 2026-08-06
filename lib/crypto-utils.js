// crypto-utils.js — AES-256-GCM encryption for data at rest.
//
// Used to encrypt MT5 credentials and strategy profiles before they touch
// disk. The key comes from STRATEGY_ENC_KEY (32-byte hex); if unset, a key
// is generated on first boot and persisted to data/enc_key (gitignored) so
// dev/test environments work out of the box. Never log credentials.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function loadOrCreateKey() {
  if (process.env.STRATEGY_ENC_KEY && process.env.STRATEGY_ENC_KEY.length >= 32) {
    return Buffer.from(process.env.STRATEGY_ENC_KEY.slice(0, 64), 'hex');
  }
  const keyFile = path.join(DATA_DIR, 'enc_key');
  if (fs.existsSync(keyFile)) {
    return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  console.warn('[crypto] STRATEGY_ENC_KEY not set; generated a key at data/enc_key');
  return key;
}

const key = loadOrCreateKey();

/** Encrypt a string/object. Returns base64 `iv:tag:ciphertext`. */
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

/** Decrypt the output of encrypt(). Returns the original value type. */
function decrypt(payload) {
  const [ivB64, tagB64, dataB64] = String(payload).split(':');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  const text = decrypted.toString('utf8');
  // Return parsed JSON when possible, otherwise the raw string.
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

module.exports = { encrypt, decrypt };
