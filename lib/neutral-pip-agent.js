// lib/neutral-pip-agent.js — Hermes orchestration layer (the "brain").
// TRADING MODE: this module coordinates the LLM call, memory, and risk context.
// It does NOT execute trades; execution is server-side via /analyze pipeline.

const hermesMemory = require('./hermes-memory');
const { riskGate } = require('./risk-gate');
const Anthropic = require('@anthropic-ai/sdk');

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

Self-improvement note: You have access to memory from past sessions. Use it. If you previously analyzed this pair and the outcome is in memory, reference it explicitly.`;

/**
 * Main agent entry point.
 * @param {Object} params
 * @param {string} params.message - Current user message
 * @param {Array} params.history - Conversation history [{role, content}]
 * @param {string} params.chart_url - Base64 data URL or HTTPS URL for chart image
 * @param {Array} params.attachments - Additional attachments (metadata only)
 * @param {string} params.session_id - Session identifier
 * @param {string} params.user_id - User identifier (from auth)
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

  const response = await client.messages.create({
    model,
    max_tokens: 1500,
    system: systemPrompt,
    messages,
  });

  const reply = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

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
    model_used: response.model,
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

module.exports = {
  runAgent,
  recordTradeOutcome,
};