// lib/alarms.js — Proactive alarm system for strategy match alerts.
// TRADING MODE: read-only monitoring. Never executes trades autonomously.
// Alerts are delivered via push notification; user decides whether to act.

const store = require('./store');
const strategyStore = require('./strategy-store');
const marketData = require('./market-data');
const hermesMemory = require('./hermes-memory');
const { runBacktest } = require('./backtest-engine');
const { evaluateCombo } = require('./backtest-engine');

const DEFAULT_CHECK_INTERVAL_MINUTES = 5;
const ALERT_DEDUPE_HOURS = 4; // don't re-alert same setup within this window

/**
 * Evaluate a user's strategy against a symbol's current chart state.
 * Returns match details or null if no match.
 */
async function evaluateStrategyMatch(userId, symbol, timeframe) {
  const profile = strategyStore.getProfile(userId);
  if (!profile) return null;

  try {
    const chart = await marketData.fetchCandles(symbol, timeframe);
    const combo = evaluateCombo(profile.profile, symbol, timeframe, chart.candles);
    
    if (!combo || combo.sample_size === 0) return null;

    // Build a summary similar to /analyze response
    const chartSummary = buildChartSummary(chart, combo);
    const strategyMatch = buildStrategyMatch(profile.profile, combo);
    const reasoning = buildReasoning(profile.profile, combo, chart);

    return {
      symbol,
      timeframe,
      matched: true,
      chart_summary: chartSummary,
      strategy_match: strategyMatch,
      reasoning_text: reasoning,
      backtest_accuracy: {
        win_rate: combo.win_rate,
        wins: combo.wins,
        losses: combo.losses,
        sample_size: combo.sample_size,
      },
      proposed_trade: buildProposedTrade(chart, combo),
    };
  } catch (err) {
    console.warn(`[alarms] Strategy eval failed for ${userId} ${symbol} ${timeframe}:`, err.message);
    return null;
  }
}

function buildChartSummary(chart, combo) {
  const latest = chart.candles[chart.candles.length - 1];
  const prev = chart.candles[chart.candles.length - 2];
  const direction = latest.close > prev.close ? 'bullish' : 'bearish';
  return `${chart.symbol} ${chart.timeframe}: Price ${latest.close.toFixed(5)} (${direction}), ${combo.wins}W/${combo.losses}L backtested`;
}

function buildStrategyMatch(profile, combo) {
  const criteria = [];
  if (combo.wins > combo.losses) criteria.push('Positive expectancy');
  if (combo.win_rate > 0.55) criteria.push('Win rate > 55%');
  if (combo.sample_size > 20) criteria.push('Adequate sample size');
  return {
    matched: true,
    criteria_hit: criteria,
    criteria_missed: [],
  };
}

function buildReasoning(profile, combo, chart) {
  const latest = chart.candles[chart.candles.length - 1];
  return `Strategy matches current setup on ${chart.symbol} ${chart.timeframe}. ` +
    `Backtest: ${combo.wins}W/${combo.losses}L (${(combo.win_rate * 100).toFixed(1)}% WR) over ${combo.sample_size} trades. ` +
    `Current price ${latest.close.toFixed(5)}. Entry: ${combo.avg_rr > 0 ? 'favorable' : 'review required'}.`;
}

function buildProposedTrade(chart, combo) {
  const latest = chart.candles[chart.candles.length - 1];
  const entry = latest.close;
  // Simple ATR-based stop/target (would need ATR from indicators)
  const atrApprox = latest.close * 0.005; // rough 0.5% ATR
  return {
    symbol: chart.symbol,
    direction: combo.wins > combo.losses ? 'long' : 'short',
    entry: entry,
    stop: entry - atrApprox * 1.5,
    target: entry + atrApprox * 3.0,
    risk_percent: 1.5,
  };
}

/**
 * Check if an alert for this user/symbol/setup was sent recently.
 * Uses a simple in-memory cache with timestamp; could be persisted.
 */
const alertDedupe = new Map(); // key: "${userId}:${symbol}:${timeframe}:${setupHash}" -> timestamp

function makeSetupHash(match) {
  // Simple hash based on symbol, timeframe, and key levels
  const key = `${match.symbol}:${match.timeframe}:${match.proposed_trade?.entry?.toFixed(2) || ''}:${match.proposed_trade?.stop?.toFixed(2) || ''}`;
  return key;
}

function isAlertDeduped(userId, match) {
  const key = `${userId}:${makeSetupHash(match)}`;
  const lastSent = alertDedupe.get(key);
  if (!lastSent) return false;
  const hoursSince = (Date.now() - lastSent) / (1000 * 60 * 60);
  return hoursSince < ALERT_DEDUPE_HOURS;
}

function markAlertSent(userId, match) {
  const key = `${userId}:${makeSetupHash(match)}`;
  alertDedupe.set(key, Date.now());
}

/**
 * Send push notification via the app's notification service.
 * This is a placeholder - actual implementation would call FCM/APNS.
 */
async function sendPushNotification(userId, match) {
  // In production: call FCM HTTP v1 API or use a push service
  // For now, log and store in user's notification queue
  const notification = {
    id: require('uuid').v4(),
    user_id: userId,
    type: 'strategy_alert',
    title: `Strategy Match: ${match.symbol} ${match.timeframe}`,
    body: `${match.chart_summary}. ${match.reasoning_text}`,
    data: { match },
    priority: 'high',
    channel: 'alarms', // high-priority channel
    created_at: new Date().toISOString(),
    read: false,
  };
  
  // Store in user's notification queue (for app to fetch)
  store.update('notifications', userId, (notifs) => [notification, ...(notifs || [])].slice(0, 100));
  
  // TODO: Actually send via FCM when credentials configured
  console.log(`[alarms] Push notification queued for user ${userId}:`, notification.title);
  
  return notification;
}

/**
 * Main alarm check function - runs per user.
 */
async function checkUserAlarms(userId) {
  // Get user's alarm settings
  const settings = store.get('settings', userId);
  const alarmSettings = settings?.alarms || {
    enabled: true,
    symbols: [], // empty = use watchlist
    timeframes: ['H1', 'H4'],
    interval_minutes: DEFAULT_CHECK_INTERVAL_MINUTES,
  };

  if (!alarmSettings.enabled) return { checked: 0, alerts: 0 };

  // Get symbols to watch: alarm settings override, else watchlist, else preferred pairs from strategy
  let symbols = alarmSettings.symbols.length > 0 
    ? alarmSettings.symbols 
    : (await getWatchlistSymbols(userId));
  
  if (symbols.length === 0) {
    const profile = strategyStore.getProfile(userId);
    symbols = profile?.profile?.preferred_pairs || [];
  }
  if (symbols.length === 0) return { checked: 0, alerts: 0 };

  const timeframes = alarmSettings.timeframes || ['H1', 'H4'];
  let checked = 0;
  let alerts = 0;

  for (const symbol of symbols) {
    for (const timeframe of timeframes) {
      checked++;
      const match = await evaluateStrategyMatch(userId, symbol, timeframe);
      
      if (match && match.matched) {
        if (!isAlertDeduped(userId, match)) {
          await sendPushNotification(userId, match);
          markAlertSent(userId, match);
          alerts++;
          
          // Also save to memory for context
          hermesMemory.initDb(); hermesMemory.getOrCreateSession(`alarms:${userId}`, userId); hermesMemory.saveMemory(
            `alarms:${userId}`,
            'trade_analysis',
            `ALERT: ${symbol} ${timeframe} strategy match — ${match.reasoning_text}`
          );
        }
      }
    }
  }

  return { checked, alerts };
}

async function getWatchlistSymbols(userId) {
  const prefs = store.get('watchlist', userId);
  return prefs?.symbols || [];
}

/**
 * Run alarm check for all users who have alarms enabled.
 */
async function runAlarmCycle() {
  console.log('[alarms] Starting alarm cycle...');
  const userIds = store.keys('settings');
  let totalChecked = 0;
  let totalAlerts = 0;

  for (const userId of userIds) {
    try {
      // Skip paused agents: deactivation pauses chat, analysis and alarms
      // together. Deactivated users keep their data; this is just a pause.
      const user = store.get('users', userId);
      if (user && user.agent_active === false) continue;
      const result = await checkUserAlarms(userId);
      totalChecked += result.checked;
      totalAlerts += result.alerts;
    } catch (err) {
      console.error(`[alarms] Error checking user ${userId}:`, err.message);
    }
  }

  console.log(`[alarms] Cycle complete: ${totalChecked} checks, ${totalAlerts} alerts sent`);
  return { checked: totalChecked, alerts: totalAlerts };
}

/**
 * Start the alarm scheduler.
 * @param {number} intervalMinutes - Check interval in minutes
 */
function startAlarmScheduler(intervalMinutes = DEFAULT_CHECK_INTERVAL_MINUTES) {
  const intervalMs = intervalMinutes * 60 * 1000;
  
  // Run immediately on start
  runAlarmCycle().catch(console.error);
  
  // Then schedule
  const timer = setInterval(() => {
    runAlarmCycle().catch(console.error);
  }, intervalMs);

  console.log(`[alarms] Scheduler started (every ${intervalMinutes} minutes)`);
  return timer;
}

/**
 * Stop the alarm scheduler.
 */
function stopAlarmScheduler(timer) {
  if (timer) clearInterval(timer);
  console.log('[alarms] Scheduler stopped');
}

/**
 * Get user's alarm settings.
 */
function getAlarmSettings(userId) {
  const settings = store.get('settings', userId);
  return settings?.alarms || {
    enabled: true,
    symbols: [],
    timeframes: ['H1', 'H4'],
    interval_minutes: DEFAULT_CHECK_INTERVAL_MINUTES,
  };
}

/**
 * Update user's alarm settings.
 */
function setAlarmSettings(userId, newSettings) {
  store.update('settings', userId, (s) => ({
    ...(s || {}),
    alarms: { ...getAlarmSettings(userId), ...newSettings },
  }));
  return getAlarmSettings(userId);
}


/**
 * Get all alarms for a user.
 */
function getAlarms(userId) {
  const settings = store.get('settings', userId);
  return settings?.alarms?.items || [];
}

/**
 * Get a specific alarm by ID.
 */
function getAlarm(userId, alarmId) {
  const alarms = getAlarms(userId);
  return alarms.find(a => a.id === alarmId);
}

/**
 * Create or update an alarm for a user.
 */
function setAlarm(userId, alarm) {
  const settings = store.get('settings', userId) || {};
  const currentAlarms = settings.alarms?.items || [];
  
  const now = Date.now();
  let alarmId = alarm.id;
  let alarms;
  
  if (alarmId) {
    // Update existing
    alarms = currentAlarms.map(a => a.id === alarmId ? { ...a, ...alarm, updated_at: now } : a);
  } else {
    // Create new
    alarmId = `alarm_${now}_${Math.random().toString(36).substr(2, 9)}`;
    alarms = [...currentAlarms, { ...alarm, id: alarmId, created_at: now, updated_at: now }];
  }
  
  store.update('settings', userId, (s) => ({
    ...(s || {}),
    alarms: { ...getAlarmSettings(userId), items: alarms },
  }));
  
  return { ...alarm, id: alarmId, created_at: alarm.created_at || now, updated_at: now };
}

/**
 * Remove an alarm by ID.
 */
function removeAlarm(userId, alarmId) {
  const currentAlarms = getAlarms(userId);
  const alarms = currentAlarms.filter(a => a.id !== alarmId);
  
  store.update('settings', userId, (s) => ({
    ...(s || {}),
    alarms: { ...getAlarmSettings(userId), items: alarms },
  }));
  
  return { removed: true, alarmId };
}

module.exports = {
  evaluateStrategyMatch,
  checkUserAlarms,
  runAlarmCycle,
  startAlarmScheduler,
  stopAlarmScheduler,
  getAlarmSettings,
  setAlarmSettings,
  getAlarms,
  getAlarm,
  setAlarm,
  removeAlarm,
  sendPushNotification,
  alertDedupe,
  ALERT_DEDUPE_HOURS,
};