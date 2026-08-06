// TRADING MODE: this is the ONLY path through which trading chat is analyzed.
// Never performs on-screen automation. Trade execution is server-side only.

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');

// ─── Neutral Pip Trading Agent System Prompt ─────────────────────────────────
const NEUTRAL_PIP_SYSTEM = `You are Neutral Pip, an AI trading co-pilot.

Your role:
- Analyze forex and crypto charts when the user shares them
- Identify price action patterns, support/resistance, trend direction
- Suggest trade ideas with clear entry, stop loss, and take profit levels
- Assess risk before any trade recommendation
- Track your past analysis against real outcomes to improve over time
- NEVER fabricate win rates or confidence scores — only report real backtest data

Your personality:
- Calm, precise, analyst-style. Not hyped, not vague.
- Always show your reasoning. "Price is above the 200 EMA and rejecting resistance at 1.0850, so bias is bearish on the retest."
- When you don't have enough data to make a call, say so clearly.

Your constraints:
- You do NOT execute trades directly. You recommend; the human decides.
- You do NOT invent numbers. If there's no backtest data, say "no data yet."
- You DO flag when risk is too high and refuse to suggest a trade that violates risk rules.

Risk rules (hard limits — never suggest trades that break these):
- Max risk per trade: 2% of account
- Max daily loss: 5% of account
- If daily loss limit is hit: no more trade ideas today, only analysis.

Memory and self-improvement:
- You remember past analysis from the session journal
- You note when your analysis was wrong and adjust your approach
- You build a model of what works for this user's trading style over time

When given a chart image:
1. Describe what you see (timeframe, pair if visible, current price context)
2. Identify key levels and patterns
3. State your directional bias and why
4. If a trade setup exists: entry zone, stop loss, take profit, risk %
5. Confidence level with reasoning (not a fabricated number)

When asked general trading questions: answer like a calm, experienced analyst would.`;

// ─── Hermes-style memory store (in-memory for now, Redis next phase) ──────────
const sessionMemory = new Map(); // sessionId → { trades: [], strategies: [], preferences: {} }

function getMemory(sessionId) {
  if (!sessionMemory.has(sessionId)) {
    sessionMemory.set(sessionId, { trades: [], strategies: [], lastAnalysis: null });
  }
  return sessionMemory.get(sessionId);
}

function buildContextFromMemory(memory) {
  if (!memory.trades.length && !memory.lastAnalysis) return '';
  
  let context = '\n\n--- Session Memory ---\n';
  if (memory.lastAnalysis) {
    context += `Last analysis: ${memory.lastAnalysis}\n`;
  }
  if (memory.trades.length) {
    const recent = memory.trades.slice(-3);
    context += `Recent trade ideas this session: ${JSON.stringify(recent, null, 2)}\n`;
  }
  context += '--- End Memory ---\n';
  return context;
}

// ─── POST /chat ───────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { message, history = [], attachments = [], chart_url, session_id = 'default' } = req.body || {};

  console.log('[chat] message:', message?.slice(0, 100));
  console.log('[chat] history length:', history.length);
  console.log('[chat] attachments count:', attachments.length);
  console.log('[chat] chart_url:', chart_url || 'none');
  console.log('[chat] session_id:', session_id);

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  // Use user's API key from header, or fall back to .env
  const apiKey = req.headers['x-api-key'] || process.env.CLAUDE_API_KEY;
  const model = req.headers['x-model'] || 'claude-sonnet-4-6';
  
  if (!apiKey || apiKey === 'your_key_here') {
    return res.status(200).json({ 
      reply: '[Backend] No API key configured. Add your Claude or OpenRouter key in Settings → AI Engine Configuration, then set your backend URL to this server.' 
    });
  }

  try {
    const memory = getMemory(session_id);
    const memoryContext = buildContextFromMemory(memory);
    const systemPrompt = NEUTRAL_PIP_SYSTEM + memoryContext;

    const client = new Anthropic({ apiKey });

    // Build messages array from history + current message
    const messages = [];
    
    // Add conversation history
    for (const turn of history) {
      messages.push({
        role: turn.role || (turn.isUser ? 'user' : 'assistant'),
        content: turn.content || turn.text || ''
      });
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
          source: { type: 'base64', media_type: mediaType, data: base64Data }
        },
        { type: 'text', text: message }
      ];
    } else if (chart_url) {
      // URL-based image
      userContent = [
        { type: 'image', source: { type: 'url', url: chart_url } },
        { type: 'text', text: message }
      ];
    } else {
      userContent = message;
    }

    messages.push({ role: 'user', content: userContent });

    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages
    });

    const reply = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    // Store in session memory
    if (reply.toLowerCase().includes('entry') || reply.toLowerCase().includes('buy') || reply.toLowerCase().includes('sell')) {
      memory.lastAnalysis = `${new Date().toISOString()}: ${reply.slice(0, 200)}...`;
    }

    res.json({ reply, model: response.model, session_id });

  } catch (err) {
    console.error('[chat] Claude API error:', err.message);
    
    if (err.status === 401) {
      return res.status(200).json({ reply: '[Backend] Invalid API key. Check your key in Settings.' });
    }
    if (err.status === 429) {
      return res.status(200).json({ reply: '[Backend] Rate limited. Wait a moment and try again.' });
    }
    
    res.status(500).json({ error: 'AI call failed', detail: err.message });
  }
});

module.exports = router;
