// lib/neutral-pip-agent.js — Hermes orchestration layer (the "brain").
// TRADING MODE: this module coordinates the LLM call, memory, risk context,
// and configuration tools. It does NOT execute trades autonomously; trade
// execution requires an explicit check_risk approval in the same turn and is
// only ever sent to the server-side MT5 bridge.

const hermesMemory = require('./hermes-memory');
const { riskGate } = require('./risk-gate');
const marketData = require('./market-data');
const mt5Bridge = require('./mt5-bridge');
const { dailyUsage } = require('./daily-usage');
const strategyStore = require('./strategy-store');
const store = require('./store');
const { runBacktest, evaluateCombo } = require('./backtest-engine');
const alarms = require('./alarms');
const Anthropic = require('@anthropic-ai/sdk');

// Hard ceiling on LLM iterations within a single user turn, so a runaway
// tool loop can never burn unbounded tokens.
const MAX_TOOL_CALLS = 6;

// Hardcoded Neutral Pip system prompt
const NEUTRAL_PIP_SYSTEM = `You are Neutral Pip, an AI trading co-pilot built for serious forex and crypto traders.

Your role:
- Analyze charts when the user shares them (images or URLs)
- Identify price action patterns, support/resistance, trend direction, key levels
- Suggest trade ideas with entry zone, stop loss, take profit, and risk %
- Give multi-timeframe context when possible (daily bias → H4 structure → entry TF)
- Check session awareness: London/NY overlap vs Asian session, low liquidity periods
- Flag upcoming high-impact news events that could invalidate the setup
- Enforce risk rules before suggesting any trade
- Help the user configure their agent: strategy profile, risk rules, alarms, and skills

Your personality:
- Calm, precise, analyst-style. Not hyped, not vague.
- Always show your reasoning step by step.
- When data is insufficient, say so clearly — never fabricate.
- Talk like you are explaining a setup to a fellow experienced trader.

Hard risk rules (NEVER suggest a trade that violates these):
- Max risk per trade: 2% of account
- Max daily loss: 5% of account
- If daily loss limit is hit: no more trade ideas, analysis only
- Never suggest trading during high-impact news unless the user explicitly asks
- Confidence scores must come from real backtest data — never invent a percentage

When given a chart image:
1. Describe what you see (pair, timeframe if visible, current price context)
2. Identify key levels: support, resistance, trendlines, patterns
3. State directional bias and why
4. If a valid setup exists: entry zone, stop loss, take profit, risk %
5. What would invalidate this idea
6. Confidence level — only if backtest data supports it, else say 'unverified setup'

Self-improvement note: You have access to memory from past sessions. Use it. If you previously analyzed this pair and the outcome is in memory, reference it explicitly.

AVAILABLE TOOLS (use them to act on the user's trading environment and configuration):

1. get_chart_data — fetch live OHLCV candles for {symbol, timeframe}. Use for any price/chart question.
2. get_account_state — fetch the user's live MT5 account state (balance, equity, open positions). Read-only.
3. check_risk — evaluate a proposed trade {symbol, direction, entry, stop, target, risk_percent} against the user's risk rules and live account. MUST be called before place_trade with the EXACT same parameters.
4. place_trade — execute a real trade via the MT5 bridge. Only valid after check_risk approved the IDENTICAL parameters in the same turn. Never call it speculatively.
5. run_backtest — run the user's stored strategy backtest over preferred pairs × timeframes on real candle data.
6. update_strategy_profile — partial update of the strategy profile: rules, indicators, preferred_pairs, timeframes, setup_description. Only provided fields change.
7. update_risk_rules — update max_risk_percent, max_daily_loss_percent, max_correlated_positions.
8. set_alarm — create or update an alarm {symbol, timeframe, condition_description, active} for strategy-match alerts.
9. remove_alarm — remove an alarm by id.
10. add_skill — save a user-taught skill to the knowledge base {name, description, content}. This is a durable skill the user wants you to remember.
11. list_current_config — show the user's current strategy profile, risk rules, alarms, and skills.

TOOL RULES:
- Configuration changes (tools 6-11) must be CONFIRMED in your reply: state exactly what changed and the new value. Never apply changes silently.
- Never invent numbers: get_chart_data, get_account_state and run_backtest return real data. Use only those values in your analysis.
- For any trade you propose, ALWAYS call check_risk first, then place_trade with the IDENTICAL parameters (same symbol, direction, entry, stop, target, risk_percent).`;

// Tool definitions exposed to the model. The dispatcher switch in runTool
// must stay in sync with these names.
const TOOLS = [
  {
    name: 'get_chart_data',
    description: 'Fetch live OHLCV candles for a symbol and timeframe. Use before any price/chart analysis.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading symbol, e.g. EURUSD, XAUUSD, BTCUSD' },
        timeframe: { type: 'string', enum: ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'], description: 'Candle timeframe' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_account_state',
    description: "Fetch the user's live MT5 account state: balance, equity, open positions and recent history. Read-only.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'check_risk',
    description: 'Evaluate a proposed trade against the user\'s risk rules and live account state. MUST be called with the exact same parameters before place_trade; place_trade is rejected unless the identical trade passed here in the same turn.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading symbol' },
        direction: { type: 'string', enum: ['long', 'short'], description: 'Trade direction' },
        entry: { type: 'number', description: 'Entry price' },
        stop: { type: 'number', description: 'Stop loss price' },
        target: { type: 'number', description: 'Take profit price' },
        risk_percent: { type: 'number', description: 'Risk as % of account balance' },
      },
      required: ['symbol', 'direction', 'entry', 'stop', 'target', 'risk_percent'],
    },
  },
  {
    name: 'place_trade',
    description: 'Execute a real trade through the MT5 bridge. ONLY valid after check_risk approved the identical parameters in the same conversation turn.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading symbol' },
        direction: { type: 'string', enum: ['long', 'short'], description: 'Trade direction' },
        entry: { type: 'number', description: 'Entry price' },
        stop: { type: 'number', description: 'Stop loss price' },
        target: { type: 'number', description: 'Take profit price' },
        risk_percent: { type: 'number', description: 'Risk as % of account balance' },
      },
      required: ['symbol', 'direction', 'entry', 'stop', 'target', 'risk_percent'],
    },
  },
  {
    name: 'run_backtest',
    description: "Run the user's stored strategy backtest across preferred pairs and timeframes on real candle data. Returns win rate, avg R:R and per-combo results, and attaches them to the current strategy version.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'update_strategy_profile',
    description: "Update the user's strategy profile with partial changes (rules, indicators, preferred_pairs, timeframes, setup_description). Only specified fields are updated.",
    input_schema: {
      type: 'object',
      properties: {
        rules: { type: 'string', description: 'Trading rules in natural language' },
        indicators: { type: 'array', items: { type: 'string' }, description: 'List of indicators to use' },
        preferred_pairs: { type: 'array', items: { type: 'string' }, description: 'Preferred trading pairs' },
        timeframes: { type: 'array', items: { type: 'string' }, description: 'Preferred timeframes' },
        setup_description: { type: 'string', description: 'Description of the trade setup criteria' },
      },
    },
  },
  {
    name: 'update_risk_rules',
    description: "Update the user's risk management rules",
    input_schema: {
      type: 'object',
      properties: {
        max_risk_percent: { type: 'number', description: 'Maximum risk per trade as percentage of account' },
        max_daily_loss_percent: { type: 'number', description: 'Maximum daily loss as percentage of account' },
        max_correlated_positions: { type: 'number', description: 'Maximum number of correlated positions' },
      },
    },
  },
  {
    name: 'set_alarm',
    description: 'Create or update an alarm for strategy match alerts',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Alarm ID (optional, for updating existing)' },
        symbol: { type: 'string', description: 'Trading symbol to watch' },
        timeframe: { type: 'string', description: 'Timeframe to watch' },
        condition_description: { type: 'string', description: 'Description of the condition that triggers the alarm' },
        active: { type: 'boolean', description: 'Whether the alarm is active' },
      },
      required: ['symbol', 'timeframe', 'condition_description'],
    },
  },
  {
    name: 'remove_alarm',
    description: 'Remove an alarm by ID',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Alarm ID to remove' },
      },
      required: ['id'],
    },
  },
  {
    name: 'add_skill',
    description: "Add a user-taught skill to the agent's knowledge base",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name' },
        description: { type: 'string', description: 'Skill description' },
        content: { type: 'string', description: 'Detailed skill content/instructions' },
      },
      required: ['name', 'description', 'content'],
    },
  },
  {
    name: 'list_current_config',
    description: "Get the user's current strategy profile, risk rules, active alarms, and skills",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Main agent entry point.
 * @param {Object} params
 * @param {string} params.message - Current user message
 * @param {Array} params.history - Conversation history [{role, content}]
 * @param {string} params.chart_url - Base64 data URL or HTTPS URL for chart image
 * @param {Array} params.attachments - Additional attachments (metadata only)
 * @param {string} params.session_id - Session identifier
 * @param {string} params.user_id - User identifier (from auth, server-side)
 * @param {string} params.api_key - Anthropic/OpenRouter API key
 * @param {string} params.model - Model name (default: 'claude-sonnet-4-6')
 * @returns {Promise<{reply, model_used, session_id, memory_saved: boolean}>}
 */
async function runAgent(params) {
  const {
    message,
    history = [],
    chart_url,
    attachments = [],
    session_id = 'default',
    user_id = 'anonymous',
    api_key,
    model = 'claude-sonnet-4-6',
  } = params;

  if (!api_key) {
    throw new Error('API key required');
  }

  // Ensure DB is initialized and session exists
  hermesMemory.initDb();
  hermesMemory.getOrCreateSession(session_id, user_id);

  // Build context block from persistent memory
  const contextBlock = hermesMemory.buildContextBlock(session_id);
  const systemPrompt = NEUTRAL_PIP_SYSTEM + (contextBlock ? '\n\n' + contextBlock : '');

  // Build messages array from history + current message
  const messages = [];

  // Add conversation history
  for (const turn of history) {
    const role = turn.role || (turn.isUser ? 'user' : 'assistant');
    const content = turn.content || turn.text || '';
    if (content) {
      messages.push({ role, content });
    }
  }

  // Build current user message (with image if provided)
  let userContent;

  if (chart_url && chart_url.startsWith('data:image')) {
    // Base64 image from app
    const [header, base64Data] = chart_url.split(',');
    const mediaType = header.match(/data:(.*?);/)?.[1] || 'image/jpeg';

    userContent = [
      {
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: base64Data },
      },
      { type: 'text', text: message },
    ];
  } else if (chart_url) {
    // URL-based image
    userContent = [
      { type: 'image', source: { type: 'url', url: chart_url } },
      { type: 'text', text: message },
    ];
  } else {
    userContent = message;
  }

  messages.push({ role: 'user', content: userContent });

  // Call Anthropic API
  const client = new Anthropic({ apiKey: api_key });

  // One-time risk approval gate: place_trade is rejected unless check_risk
  // approved the exact same parameters earlier in this turn.
  let riskApproved = false;
  let lastCheckRiskParams = null;

  const toolCtx = { user_id, session_id };

  const runTool = async (name, input) => {
    let toolResult;

    switch (name) {
      case 'get_chart_data': {
        const { symbol, timeframe = 'H1' } = input;
        try {
          const data = await marketData.fetchCandles(symbol, timeframe);
          const candles = data.candles.slice(-60);
          const latest = candles[candles.length - 1];
          const prev = candles[candles.length - 2];
          toolResult = {
            symbol: data.symbol,
            timeframe: data.timeframe,
            source: data.source,
            current_price: latest.close,
            change: prev ? Math.round((latest.close - prev.close) * 100000) / 100000 : 0,
            period_high: Math.max(...candles.map((c) => c.high)),
            period_low: Math.min(...candles.map((c) => c.low)),
            candles: candles.map((c) => ({
              t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume,
            })),
          };
        } catch (err) {
          toolResult = { error: err.message };
        }
        break;
      }

      case 'get_account_state': {
        const cred = store.get('mt5_credentials', user_id);
        if (!cred || !cred.enc) {
          toolResult = { available: false, reason: 'No MT5 account connected. Connect one in the app first.' };
          break;
        }
        const { decrypt } = require('./crypto-utils');
        const accountState = await mt5Bridge.getAccountState(decrypt(cred.enc));
        if (!accountState.available) {
          toolResult = accountState;
          break;
        }
        toolResult = {
          available: true,
          balance: accountState.balance,
          equity: accountState.equity,
          open_positions: Array.isArray(accountState.open_positions)
            ? accountState.open_positions.slice(0, 20)
            : [],
          recent_history: Array.isArray(accountState.history)
            ? accountState.history.slice(0, 10)
            : [],
        };
        break;
      }

      case 'check_risk': {
        const order = {
          symbol: input.symbol,
          direction: input.direction,
          entry: input.entry,
          stop: input.stop,
          target: input.target,
          risk_percent: input.risk_percent,
        };
        const profile = strategyStore.getProfile(user_id);
        const cred = store.get('mt5_credentials', user_id);
        let accountState = null;
        if (cred && cred.enc) {
          try {
            const { decrypt } = require('./crypto-utils');
            accountState = await mt5Bridge.getAccountState(decrypt(cred.enc));
          } catch {
            accountState = null;
          }
        }
        const gate = riskGate(
          order,
          profile ? profile.profile : { risk_tolerance: {} },
          accountState,
          dailyUsage(accountState),
        );
        if (gate.approved) {
          riskApproved = true;
          lastCheckRiskParams = JSON.stringify(order);
        } else {
          riskApproved = false;
        }
        toolResult = {
          approved: gate.approved,
          risk_gate_result: {
            reason: gate.reason,
            checks: gate.checks,
          },
        };
        break;
      }

      case 'place_trade': {
        const order = {
          symbol: input.symbol,
          direction: input.direction,
          entry: input.entry,
          stop: input.stop,
          target: input.target,
          risk_percent: input.risk_percent,
        };
        if (!riskApproved || !lastCheckRiskParams || lastCheckRiskParams !== JSON.stringify(order)) {
          toolResult = {
            executed: false,
            error: 'Trade rejected: call check_risk with the exact same parameters first, and only execute if it returns approved: true.',
          };
          break;
        }
        // Consume the one-time approval so the same gate can't be reused
        // for a different trade.
        riskApproved = false;

        const cred = store.get('mt5_credentials', user_id);
        if (!cred || !cred.enc) {
          toolResult = { executed: false, error: 'No MT5 account connected. Connect one in the app first.' };
          break;
        }
        const { decrypt } = require('./crypto-utils');
        const result = await mt5Bridge.executeTrade(order, decrypt(cred.enc));
        if (result.executed) {
          store.update('journal', user_id, (entries) => {
            const list = Array.isArray(entries) ? entries : [];
            return [
              {
                symbol: order.symbol,
                direction: order.direction,
                entry: order.entry,
                stop: order.stop,
                target: order.target,
                risk_percent: order.risk_percent,
                status: 'open',
                opened_at: new Date().toISOString(),
                trade_id: result.trade_id || null,
                source: 'agent_tool',
              },
              ...list,
            ];
          });
        }
        toolResult = result.executed
          ? {
              executed: true,
              trade_id: result.trade_id,
              message: `Trade executed: ${String(order.direction).toUpperCase()} ${order.symbol} entry ${order.entry}, stop ${order.stop}, target ${order.target}.`,
            }
          : { executed: false, reason: result.reason };
        break;
      }

      case 'run_backtest': {
        const profile = strategyStore.getProfile(user_id);
        if (!profile) {
          toolResult = { error: 'No strategy profile found. Set one up first or use update_strategy_profile.' };
          break;
        }
        const result = await runBacktest(profile.profile, (symbol, timeframe) =>
          marketData.fetchCandles(symbol, timeframe),
        );
        strategyStore.attachBacktest(user_id, result);
        toolResult = {
          setup_id: result.setup_id,
          wins: result.wins,
          losses: result.losses,
          sample_size: result.sample_size,
          win_rate: result.win_rate,
          avg_rr: result.avg_rr,
          last_run_at: result.last_run_at,
          per_combo: result.per_combo.map((c) => ({
            symbol: c.symbol,
            timeframe: c.timeframe,
            wins: c.wins,
            losses: c.losses,
            sample_size: c.sample_size,
            win_rate: c.win_rate,
          })),
          errors: result.errors,
        };
        break;
      }

      case 'update_strategy_profile': {
        const profile = strategyStore.getProfile(user_id);
        if (!profile) {
          toolResult = { error: 'No strategy profile found. Create one first before updating.' };
          break;
        }
        const updates = {};
        if (input.rules !== undefined) updates.rules = input.rules;
        if (input.indicators !== undefined) updates.indicators = input.indicators;
        if (input.preferred_pairs !== undefined) updates.preferred_pairs = input.preferred_pairs;
        if (input.timeframes !== undefined) updates.timeframes = input.timeframes;
        if (input.setup_description !== undefined) updates.setup_description = input.setup_description;
        if (Object.keys(updates).length === 0) {
          toolResult = { error: 'Nothing to update: provide at least one field.' };
          break;
        }
        const saved = strategyStore.saveProfile(user_id, { ...profile.profile, ...updates }, null);
        toolResult = {
          success: true,
          message: `Strategy profile updated (v${saved.version}).`,
          updated_fields: Object.keys(updates),
          new_values: updates,
        };
        break;
      }

      case 'update_risk_rules': {
        const profile = strategyStore.getProfile(user_id);
        if (!profile) {
          toolResult = { error: 'No strategy profile found. Create one first before updating.' };
          break;
        }
        const tolerance = { ...(profile.profile.risk_tolerance || {}) };
        if (input.max_risk_percent !== undefined) tolerance.max_risk_percent = input.max_risk_percent;
        if (input.max_daily_loss_percent !== undefined) tolerance.max_daily_loss_percent = input.max_daily_loss_percent;
        if (input.max_correlated_positions !== undefined) tolerance.max_correlated_positions = input.max_correlated_positions;
        const saved = strategyStore.saveProfile(user_id, { ...profile.profile, risk_tolerance: tolerance }, null);
        toolResult = {
          success: true,
          message: `Risk rules updated (v${saved.version}).`,
          risk_tolerance: tolerance,
        };
        break;
      }

      case 'set_alarm': {
        const alarm = {
          symbol: input.symbol,
          timeframe: input.timeframe,
          condition_description: input.condition_description,
          active: input.active !== false,
        };
        if (input.id) alarm.id = input.id;

        const result = alarms.setAlarm(user_id, alarm);
        toolResult = {
          success: true,
          message: `Alarm ${input.id ? 'updated' : 'created'} for ${input.symbol} ${input.timeframe}.`,
          alarm: result,
        };
        break;
      }

      case 'remove_alarm': {
        const result = alarms.removeAlarm(user_id, input.id);
        toolResult = {
          success: true,
          message: `Alarm ${input.id} removed.`,
          removed: result.removed,
        };
        break;
      }

      case 'add_skill': {
        hermesMemory.initDb();
        hermesMemory.getOrCreateSession(session_id, user_id);

        hermesMemory.saveSkill(session_id, input.name, input.description, input.content);
        hermesMemory.updateSkillSource(session_id, input.name, 'user_taught');

        toolResult = {
          success: true,
          message: `Skill "${input.name}" added to your knowledge base.`,
          skill: { name: input.name, description: input.description },
        };
        break;
      }

      case 'list_current_config': {
        const profile = strategyStore.getProfile(user_id);
        const alarmsList = alarms.getAlarms(user_id);
        const userSkills = hermesMemory.getSkillsBySource(session_id, 'user_taught');
        const autoSkills = hermesMemory.getSkillsBySource(session_id, 'auto');

        toolResult = {
          strategy_profile: profile
            ? {
                version: profile.version,
                updated_at: profile.updated_at,
                rules: profile.profile.rules || null,
                indicators: profile.profile.indicators || [],
                preferred_pairs: profile.profile.preferred_pairs || [],
                timeframes: profile.profile.timeframes || [],
                setup_description: profile.profile.setup_description || null,
              }
            : null,
          risk_rules: profile ? profile.profile.risk_tolerance || null : null,
          alarms: alarmsList,
          skills: {
            user_taught: userSkills.map((s) => ({ name: s.name, description: s.description, active: s.active })),
            auto_extracted: autoSkills.map((s) => ({ name: s.name, description: s.description, active: s.active })),
          },
        };
        break;
      }

      default:
        toolResult = { error: `Unknown tool: ${name}` };
    }

    return toolResult;
  };

  // Tool-use loop
  const replyParts = [];
  let finalResponse = null;
  let capped = false;
  let toolCalls = 0;

  while (toolCalls < MAX_TOOL_CALLS && !capped) {
    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    const textBlocks = response.content.filter((b) => b.type === 'text');
    for (const block of textBlocks) replyParts.push(block.text);

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      finalResponse = response;
      break;
    }

    // Answer every tool call before continuing (each is cheap; the cap
    // bounds LLM iterations, not tool executions).
    messages.push({ role: 'assistant', content: response.content });
    for (const block of toolUseBlocks) {
      toolCalls += 1;
      let result;
      try {
        result = await runTool(block.name, block.input);
      } catch (err) {
        result = { error: err.message };
      }
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) }],
      });
    }
    finalResponse = response;
    if (toolCalls >= MAX_TOOL_CALLS) capped = true;
  }

  // Cap reached: one final call without tools so the model can wrap up.
  if (capped) {
    finalResponse = await client.messages.create({
      model,
      max_tokens: 2000,
      system: systemPrompt,
      messages,
    });
  }

  const reply = finalResponse
    ? finalResponse.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
    : replyParts.join('\n').trim();

  // Save memory: always save the analysis
  hermesMemory.saveMemory(session_id, 'trade_analysis', reply.slice(0, 300));

  // Self-evaluation: if reply contains trade keywords, tag with pair if detectable
  const lowerReply = reply.toLowerCase();
  if (
    lowerReply.includes('entry') ||
    lowerReply.includes('buy') ||
    lowerReply.includes('sell') ||
    lowerReply.includes('long') ||
    lowerReply.includes('short')
  ) {
    // Try to detect pair from message or reply
    const pairMatch = message.match(
      /\b(EURUSD|GBPUSD|USDJPY|XAUUSD|XAGUSD|US500|US30|NAS100|BTCUSD|ETHUSD|BTCUSDT|ETHUSDT)\b/i
    ) || reply.match(
      /\b(EURUSD|GBPUSD|USDJPY|XAUUSD|XAGUSD|US500|US30|NAS100|BTCUSD|ETHUSD|BTCUSDT|ETHUSDT)\b/i
    );
    const pair = pairMatch ? pairMatch[1].toUpperCase() : 'unknown';
    hermesMemory.saveMemory(
      session_id,
      'trade_analysis',
      `[${pair}] ${reply.slice(0, 300)}`
    );
  }

  return {
    reply,
    model_used: finalResponse ? finalResponse.model : model,
    session_id,
    memory_saved: true,
  };
}

/**
 * Record a trade outcome and extract skill if winning pattern.
 * Called by POST /journal when a trade outcome is logged.
 * @param {string} session_id
 * @param {Object} outcome
 * @param {string} outcome.pair - Trading pair
 * @param {string} outcome.direction - 'long' or 'short'
 * @param {string} outcome.outcome - 'win' | 'loss' | 'breakeven'
 * @param {number} outcome.pnl - P&L in account currency
 * @param {string} outcome.original_analysis - The analysis that led to this trade
 */
async function recordTradeOutcome(session_id, outcome) {
  const { pair, direction, outcome: result, pnl, original_analysis } = outcome;

  // Save trade outcome to memory
  const outcomeContent = `${pair} ${direction} ${result} (P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}) — ${original_analysis?.slice(0, 200) || 'no original analysis'}`;
  hermesMemory.saveMemory(session_id, 'trade_outcome', outcomeContent);

  // Skill extraction: if winning trade, attempt to extract a reusable skill
  if (result === 'win' && pnl > 0) {
    try {
      // Simple heuristic: extract key setup elements from the original analysis
      // In a more advanced version, we'd call a small LLM here to distill the pattern
      const skillName = `${pair} ${direction === 'long' ? 'bullish' : 'bearish'} setup`;
      const skillDesc = `Winning ${direction} on ${pair}: ${original_analysis?.slice(0, 150) || 'price action setup'}`;

      hermesMemory.saveSkill(session_id, skillName, skillDesc, original_analysis || '');
    } catch (err) {
      console.warn('[neutral-pip-agent] Skill extraction failed:', err.message);
    }
  }
}

module.exports = { runAgent, recordTradeOutcome, NEUTRAL_PIP_SYSTEM, TOOLS };

