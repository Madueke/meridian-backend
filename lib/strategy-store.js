// strategy-store.js — versioned, encrypted strategy profiles per user.
//
// Each save bumps the version and keeps prior versions (capped). Profiles
// are encrypted at rest via AES-256-GCM. Backtest results are attached to
// the version they were computed against.

const store = require('./store');
const { encrypt, decrypt } = require('./crypto-utils');

const MAX_VERSIONS = 20;

function getRecord(userId) {
  const record = store.get('strategies', userId);
  if (!record || !Array.isArray(record.versions)) return null;
  return record;
}

/** Decrypt and return the current profile, plus its version + backtest. */
function getProfile(userId) {
  const record = getRecord(userId);
  if (!record) return null;
  const latest = record.versions[record.versions.length - 1];
  return {
    profile: decrypt(latest.profile_enc),
    version: latest.version,
    updated_at: latest.created_at,
    backtest: latest.backtest || null,
  };
}

/**
 * Save a new version of the profile. Returns the version number and, when a
 * backtest result is provided, attaches it to the new version.
 */
function saveProfile(userId, profile, backtest = null) {
  const record = getRecord(userId);
  const nextVersion = record ? record.versions.length + 1 : 1;
  const versionEntry = {
    version: nextVersion,
    created_at: new Date().toISOString(),
    profile_enc: encrypt({ ...profile, _version_id: `v${nextVersion}` }),
    backtest: backtest || null,
  };
  const versions = record ? [...record.versions, versionEntry] : [versionEntry];
  if (versions.length > MAX_VERSIONS) versions.splice(0, versions.length - MAX_VERSIONS);
  store.set('strategies', userId, { versions });
  return { version: nextVersion, backtest: backtest || null };
}

/** Attach a backtest result to the current (latest) version in place. */
function attachBacktest(userId, backtest) {
  store.update('strategies', userId, (record) => {
    if (!record || !Array.isArray(record.versions)) return record;
    const versions = [...record.versions];
    const latest = { ...versions[versions.length - 1], backtest };
    versions[versions.length - 1] = latest;
    return { ...record, versions };
  });
  const profile = getProfile(userId);
  return profile ? profile.backtest : null;
}

module.exports = { getProfile, saveProfile, attachBacktest, getRecord };
