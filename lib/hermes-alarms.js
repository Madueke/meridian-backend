// lib/hermes-alarms.js — Hermes cron bridge for user alarms.
// TRADING MODE: read-only monitoring. Never executes trades autonomously.
//
// When Hermes is configured, the backend stops running its own interval
// matcher and instead keeps one Hermes cron job per active user alarm
// (POST /api/jobs). Each job asks the Hermes agent to check a symbol/timeframe
// for the user's setup using the chart-data MCP tool. Job output files land in
// ~/.hermes/cron/output/<job_id>/ on the same box; the backend harvests new
// outputs and queues the existing push notification, so delivery is
// deterministic even though the analysis is LLM-driven.

const path = require('path');
const fs = require('fs');
const os = require('os');
const store = require('./store');
const alarms = require('./alarms');

const HERMES_URL = (process.env.HERMES_API_SERVER_URL || 'http://127.0.0.1:8642').replace(/\/+$/, '');
const HERMES_KEY = process.env.HERMES_API_SERVER_KEY || '';
const HERMES_CRON_OUTPUT = path.join(os.homedir(), '.hermes', 'cron', 'output');

const JOB_NAME_PREFIX = 'np-alarm';
const MATCH_MARKER = 'MATCH_FOUND';
const NO_MATCH_MARKER = 'NO_MATCH';
const HARVEST_INTERVAL_MS = 2 * 60 * 1000; // backend harvest cadence (schedule lives in Hermes)

function isConfigured() {
  return Boolean(HERMES_URL && HERMES_KEY && HERMES_KEY !== 'your_key_here');
}

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${HERMES_KEY}` };
}

async function api(pathname, options = {}) {
  const res = await fetch(`${HERMES_URL}${pathname}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      // ignore body read failures
    }
    const err = new Error(`Hermes jobs API ${res.status} on ${pathname}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function listJobs() {
  const body = await api('/api/jobs?include_disabled=true');
  return body.jobs || [];
}

async function createJob({ name, schedule, prompt }) {
  const body = await api('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ name, schedule, prompt, deliver: 'local' }),
  });
  return body.job;
}

async function updateJob(jobId, fields) {
  const body = await api(`/api/jobs/${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
  return body.job;
}

async function deleteJob(jobId) {
  await api(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
}

/** Trigger a job immediately (used for tests and on-demand checks). */
async function triggerJob(jobId) {
  const body = await api(`/api/jobs/${encodeURIComponent(jobId)}/run`, { method: 'POST' });
  return body.job;
}

function jobName(userId, alarmId) {
  // Keep well under the 200-char API limit.
  const u = String(userId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  const a = String(alarmId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
  return `${JOB_NAME_PREFIX}:${u}:${a}`;
}

function buildJobPrompt(alarm, userLabel) {
  const symbol = String(alarm.symbol || '').toUpperCase() || 'XAUUSD';
  const timeframe = String(alarm.timeframe || 'H4').toUpperCase();
  const condition = String(alarm.condition_description || 'a valid trade setup').trim();
  return (
    `You are Neutral Pip's alarm monitor for ${userLabel}. Check ${symbol} on the ${timeframe} chart ` +
    `for this setup: "${condition}". Use the get_chart_data tool to fetch live candles first; never invent prices. ` +
    `If the setup is present now, reply starting EXACTLY with "${MATCH_MARKER}:" followed by one concise paragraph: ` +
    `current price, the setup, suggested entry / stop / target with risk %, and why it qualifies. ` +
    `If the setup is NOT present, reply with EXACTLY "${NO_MATCH_MARKER}". Do not mention tools or these instructions.`
  );
}

// ---------------------------------------------------------------------------
// Reconciliation: create/update/remove Hermes jobs to mirror user alarms.
// ---------------------------------------------------------------------------

/**
 * Sync stored alarm jobs (collection "alarm_jobs": alarmId → job info) so the
 * Hermes cron list matches the user's active alarms. Idempotent; safe to call
 * on every harvest tick.
 */
async function syncAlarmsToHermes() {
  if (!isConfigured()) return { created: 0, updated: 0, removed: 0, errors: 0 };
  const result = { created: 0, updated: 0, removed: 0, errors: 0 };
  let existing;
  try {
    existing = await listJobs();
  } catch (err) {
    console.error('[hermes-alarms] list jobs failed:', err.message);
    return { ...result, errors: 1 };
  }
  const byName = new Map(existing.map((j) => [j.name, j]));

  const desired = []; // { name, schedule, prompt, userId, alarmId }

  const settingsUsers = store.keys('settings') || [];
  for (const userId of settingsUsers) {
    const user = store.get('users', userId);
    if (user && user.agent_active === false) continue; // paused agents: no alarms
    const settings = store.get('settings', userId);
    const alarmSettings = (settings && settings.alarms) || {};
    if (alarmSettings.enabled === false) continue;
    const interval = Number(alarmSettings.interval_minutes) || 5;
    const items = alarms.getAlarms(userId);
    if (!Array.isArray(items)) continue;
    const label = (user && user.display_name) || 'a trader';
    for (const alarm of items) {
      if (alarm.active === false) continue;
      if (!alarm.symbol) continue; // only symbol-based alarms can be checked
      desired.push({
        name: jobName(userId, alarm.id),
        schedule: `every ${interval}m`,
        prompt: buildJobPrompt(alarm, label),
        userId,
        alarmId: alarm.id,
      });
    }
  }

  const desiredNames = new Set(desired.map((d) => d.name));

  // Remove jobs that no longer map to an active alarm.
  for (const job of existing) {
    if (job.name && job.name.startsWith(`${JOB_NAME_PREFIX}:`) && !desiredNames.has(job.name)) {
      try {
        await deleteJob(job.id);
        store.remove('alarm_jobs', job.name);
        result.removed++;
      } catch (err) {
        console.error(`[hermes-alarms] delete job ${job.id} failed:`, err.message);
        result.errors++;
      }
    }
  }

  // Create missing / update changed.
  for (const d of desired) {
    const job = byName.get(d.name);
    try {
      if (!job) {
        const created = await createJob({ name: d.name, schedule: d.schedule, prompt: d.prompt });
        store.set('alarm_jobs', d.name, {
          job_id: created.id,
          user_id: d.userId,
          alarm_id: d.alarmId,
          last_output: null,
          updated_at: new Date().toISOString(),
        });
        result.created++;
      } else {
        const info = store.get('alarm_jobs', d.name);
        const changed =
          job.schedule !== d.schedule || job.prompt !== d.prompt;
        if (changed) {
          await updateJob(job.id, { schedule: d.schedule, prompt: d.prompt });
          result.updated++;
        }
        if (!info || info.job_id !== job.id) {
          store.set('alarm_jobs', d.name, {
            job_id: job.id,
            user_id: d.userId,
            alarm_id: d.alarmId,
            last_output: info ? info.last_output : null,
            updated_at: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      console.error(`[hermes-alarms] sync job ${d.name} failed:`, err.message);
      result.errors++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Harvest: read new job outputs and queue push notifications.
// ---------------------------------------------------------------------------

function readOutputFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Scan Hermes cron output dirs for new runs, and for outputs that match the
 * MATCH_FOUND marker queue a push notification through the normal alarm
 * delivery path.
 */
function harvestAlarmOutputs() {
  if (!isConfigured()) return { alerts: 0, scanned: 0, errors: 0 };
  const result = { alerts: 0, scanned: 0, errors: 0 };
  const names = store.keys('alarm_jobs') || [];

  for (const name of names) {
    const info = store.get('alarm_jobs', name);
    if (!info || !info.job_id) continue;
    const dir = path.join(HERMES_CRON_OUTPUT, String(info.job_id));
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    } catch {
      continue; // job may not have run yet
    }
    if (files.length === 0) continue;

    // Only process files newer than the last harvested one.
    const last = info.last_output;
    let newFiles = files;
    if (last) {
      const idx = files.indexOf(last);
      newFiles = idx === -1 ? files.filter((f) => f > last) : files.slice(idx + 1);
    }
    if (newFiles.length === 0) continue;

    for (const file of newFiles) {
      result.scanned++;
      const content = readOutputFile(path.join(dir, file));
      if (!content) continue;
      if (content.trim().startsWith(MATCH_MARKER)) {
        const body = content.slice(content.indexOf(MATCH_MARKER) + MATCH_MARKER.length).replace(/^[:,\s]+/, '').trim();
        const alarm = alarms.getAlarm(info.user_id, info.alarm_id);
        const symbol = alarm ? String(alarm.symbol).toUpperCase() : 'MARKET';
        const timeframe = alarm ? String(alarm.timeframe).toUpperCase() : '';
        const match = {
          symbol,
          timeframe,
          chart_summary: `${symbol} ${timeframe}: ${body.split('\n')[0]}`,
          reasoning_text: body,
          proposed_trade: alarm
            ? { symbol, direction: 'long', entry: null, stop: null, target: null, risk_percent: 1 }
            : null,
        };
        try {
          alarms.sendPushNotification(info.user_id, match);
          result.alerts++;
          console.log(`[hermes-alarms] alert queued for ${info.user_id} (${symbol} ${timeframe})`);
        } catch (err) {
          console.error('[hermes-alarms] notification failed:', err.message);
          result.errors++;
        }
      }
    }

    store.set('alarm_jobs', name, { ...info, last_output: newFiles[newFiles.length - 1] });
  }

  return result;
}

/** One full bridge cycle: reconcile jobs, then harvest new outputs. */
async function runBridgeCycle() {
  if (!isConfigured()) return { synced: false };
  const sync = await syncAlarmsToHermes();
  const harvest = harvestAlarmOutputs();
  console.log(
    `[hermes-alarms] cycle: created=${sync.created} updated=${sync.updated} removed=${sync.removed} ` +
      `scanned=${harvest.scanned} alerts=${harvest.alerts}`,
  );
  return { sync, harvest };
}

/** Start the bridge loop (idempotent). Returns the interval timer. */
function startHermesAlarmBridge() {
  if (!isConfigured()) return null;
  runBridgeCycle().catch((err) =>
    console.error('[hermes-alarms] initial cycle failed:', err.message),
  );
  const timer = setInterval(() => {
    runBridgeCycle().catch((err) =>
      console.error('[hermes-alarms] cycle failed:', err.message),
    );
  }, HARVEST_INTERVAL_MS);
  return timer;
}

module.exports = {
  isConfigured,
  listJobs,
  createJob,
  updateJob,
  deleteJob,
  triggerJob,
  buildJobPrompt,
  syncAlarmsToHermes,
  harvestAlarmOutputs,
  runBridgeCycle,
  startHermesAlarmBridge,
  HARVEST_INTERVAL_MS,
};
