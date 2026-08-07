// lib/usage-caps.js — Default API key usage tracking and caps.
// TRADING MODE: enforces per-user limits on server-held default key.
// Users with their own API key bypass all caps.

const store = require('./store');

const DEFAULT_DAILY_CALL_LIMIT = 20; // calls per day per user on default key
const DEFAULT_DAILY_TOKEN_LIMIT = 50000; // tokens per day per user on default key

function todayIsoPrefix() {
  return new Date().toISOString().slice(0, 10);
}

function getUsageRecord(userId) {
  const record = store.get('api_usage', userId);
  if (!record) return { calls: {}, tokens: {} };
  return record;
}

function saveUsageRecord(userId, record) {
  store.set('api_usage', userId, record);
}

function getTodayUsage(userId) {
  const record = getUsageRecord(userId);
  const today = todayIsoPrefix();
  return {
    calls: record.calls[today] || 0,
    tokens: record.tokens[today] || 0,
  };
}

function incrementUsage(userId, tokens = 0) {
  const record = getUsageRecord(userId);
  const today = todayIsoPrefix();
  
  record.calls = record.calls || {};
  record.tokens = record.tokens || {};
  record.calls[today] = (record.calls[today] || 0) + 1;
  record.tokens[today] = (record.tokens[today] || 0) + tokens;
  
  // Cleanup old entries (keep last 30 days)
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const key of Object.keys(record.calls)) {
    const ts = new Date(key).getTime();
    if (ts < cutoff) delete record.calls[key];
  }
  for (const key of Object.keys(record.tokens)) {
    const ts = new Date(key).getTime();
    if (ts < cutoff) delete record.tokens[key];
  }
  
  saveUsageRecord(userId, record);
}

function checkUsageCap(userId) {
  const { calls, tokens } = getTodayUsage(userId);
  const callLimit = Number(process.env.DEFAULT_DAILY_CALL_LIMIT) || DEFAULT_DAILY_CALL_LIMIT;
  const tokenLimit = Number(process.env.DEFAULT_DAILY_TOKEN_LIMIT) || DEFAULT_DAILY_TOKEN_LIMIT;
  
  if (calls >= callLimit) {
    return { allowed: false, reason: `Daily call limit (${callLimit}) reached. Add your own API key in Settings to continue.`, calls, tokens, callLimit, tokenLimit };
  }
  if (tokens >= tokenLimit) {
    return { allowed: false, reason: `Daily token limit (${tokenLimit}) reached. Add your own API key in Settings to continue.`, calls, tokens, callLimit, tokenLimit };
  }
  
  return { allowed: true, calls, tokens, callLimit, tokenLimit };
}

function getDefaultApiKey() {
  return process.env.DEFAULT_CLAUDE_API_KEY || null;
}

function hasUserApiKey(userId) {
  // Check if user has their own API key configured
  const settings = store.get('settings', userId);
  const aiSettings = store.get('ai_settings', userId); // might be in different store
  return !!(settings?.api_key || aiSettings?.api_key);
}

module.exports = {
  todayIsoPrefix,
  getUsageRecord,
  saveUsageRecord,
  getTodayUsage,
  incrementUsage,
  checkUsageCap,
  getDefaultApiKey,
  hasUserApiKey,
  DEFAULT_DAILY_CALL_LIMIT,
  DEFAULT_DAILY_TOKEN_LIMIT,
};