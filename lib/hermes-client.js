// lib/hermes-client.js — thin client for the local Hermes Agent API server.
// TRADING MODE: when Hermes is configured this is the ONLY LLM path. Memory,
// skills, and tool orchestration live inside Hermes, scoped per user via the
// X-Hermes-Session-Key header (always derived server-side from the resolved
// user id, never from client input). Trade execution still only ever happens
// through the server-side MT5 bridge — never on-screen automation.

const HERMES_URL = (process.env.HERMES_API_SERVER_URL || 'http://127.0.0.1:8642').replace(/\/+$/, '');
const HERMES_KEY = process.env.HERMES_API_SERVER_KEY || '';

function isConfigured() {
  return Boolean(HERMES_URL && HERMES_KEY && HERMES_KEY !== 'your_key_here');
}

// Neutral Pip's role for the Hermes path. Hermes layers this system message on
// top of its own core prompt and brings its own toolset (chart data, account
// state, trade execution and config tools arrive as MCP tools). The hand-
// written tool list from the legacy Anthropic loop must NOT be referenced here
// — those tool names do not exist in Hermes.
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
- Confidence scores must come from real data — never invent a percentage

When given a chart image:
1. Describe what you see (pair, timeframe if visible, current price context)
2. Identify key levels: support, resistance, trendlines, patterns
3. State directional bias and why
4. If a valid setup exists: entry zone, stop loss, take profit, risk %
5. What would invalidate this idea
6. Confidence level — only if data supports it, else say 'unverified setup'

Use your available tools to act on the user's trading environment and
configuration: fetch live chart data, read the account state, run backtests,
manage alarms, and update configuration when asked. Never invent numbers —
use only values returned by your tools. Never execute a trade unless the user
explicitly asks, and only after your risk rules and any approval flow have
cleared the exact parameters.

Account connections:
- If the user asks to connect an MT5 or TradingView account, call
  check_connection_status and report what it returns.
- If an account is not connected, direct the user to the app's Settings →
  Connect Trading Accounts screen (deep link: neutralpip://settings/connect-accounts).
- NEVER ask the user to type account numbers, passwords, or any other
  credentials into chat, and never repeat or acknowledge credentials if the
  user pastes them anyway. Account connection only ever happens inside the
  app, where credentials go to encrypted storage and are never seen by you.
- Your tools act on already-connected accounts using stored credentials;
  you never need, request, or handle raw credentials.`;

// Build the OpenAI-compatible user content for a message, attaching a chart
// image when present. Hermes accepts both remote http(s) URLs and
// data:image/... URLs directly in image_url parts.
function buildUserContent(message, chartUrl, attachments = []) {
  const parts = [];
  if (attachments.length > 0) {
    const meta = attachments
      .map((a) => {
        const name = a.name || a.file_name || a.filename || '';
        const kind = a.type || a.kind || '';
        return [kind, name].filter(Boolean).join(' ');
      })
      .filter(Boolean)
      .join(', ');
    if (meta) parts.push({ type: 'text', text: `Attached: ${meta}` });
  }
  parts.push({ type: 'text', text: message });
  if (chartUrl) parts.push({ type: 'image_url', image_url: { url: chartUrl } });
  return parts;
}

// Map the app's chat history into OpenAI-style messages, dropping malformed
// entries and capping length so a single request stays bounded (the app caps
// in-memory history at 20 messages already).
function buildHistory(history = []) {
  const out = [];
  for (const turn of history.slice(-20)) {
    const role = turn.role || (turn.isUser ? 'user' : 'assistant');
    const content = turn.content || turn.text || '';
    if ((role === 'user' || role === 'assistant') && content) {
      out.push({ role, content: String(content) });
    }
  }
  return out;
}

// Session-key scoping: Hermes keeps long-term memory, skills, and history
// isolated per user via X-Hermes-Session-Key. Derived server-side only.
function sanitizeSessionKey(value) {
  return String(value || 'anonymous').replace(/[\r\n\x00]/g, '').slice(0, 256);
}

/**
 * Send a chat turn to Hermes and return the assistant reply.
 * @param {Object} params
 * @param {string} params.message - Current user message
 * @param {Array}  params.history - Conversation history [{role, content}]
 * @param {string} [params.chart_url] - Base64 data URL or HTTPS URL for a chart image
 * @param {Array}  [params.attachments] - Additional attachments (metadata only)
 * @param {string} [params.session_id] - Per-conversation session id
 * @param {string} [params.user_id] - Resolved user id (server-side, from auth)
 * @param {string} [params.system_prompt] - Optional system prompt override
 * @param {Array}  [params.content] - Optional full OpenAI-style content array;
 *   overrides message/chart_url/attachments when provided
 * @returns {Promise<{reply: string, model_used: string, session_id: string}>}
 */
async function chat({
  message,
  history,
  chart_url,
  attachments = [],
  content,
  session_id = 'default',
  user_id = 'anonymous',
  system_prompt,
}) {
  if (!isConfigured()) {
    throw new Error('Hermes API server not configured');
  }

  const messages = [];
  if (system_prompt) messages.push({ role: 'system', content: system_prompt });
  messages.push(...buildHistory(history));
  messages.push({
    role: 'user',
    content: content || buildUserContent(message, chart_url, attachments),
  });

  const res = await fetch(`${HERMES_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${HERMES_KEY}`,
      'X-Hermes-Session-Key': `user:${sanitizeSessionKey(user_id)}`,
      'X-Hermes-Session-Id': sanitizeSessionKey(session_id),
    },
    body: JSON.stringify({ model: 'hermes-agent', messages, stream: false }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      // ignore body read failures
    }
    const err = new Error(`Hermes API server error ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }

  const body = await res.json();
  const reply = (body.choices?.[0]?.message?.content || '').trim();
  return {
    reply,
    model_used: body.model || 'hermes-agent',
    session_id: session_id || 'default',
  };
}

/**
 * Create an agent run via the proprietary /v1/runs API. Unlike the
 * synchronous /v1/chat/completions endpoint, a run exposes a live SSE event
 * stream (GET /v1/runs/{id}/events) through which Hermes surfaces
 * approval.request events (e.g. the MCP trade-approval elicitation) that the
 * backend resolves with POST /v1/runs/{id}/approval. Trade-capable turns
 * MUST use this path — the chat-completions endpoint has no notify callback,
 * so any elicitation there fails closed and a legit trade would be denied.
 * @returns {Promise<{run_id: string}>}
 */
async function createRun({
  message,
  history,
  chart_url,
  attachments = [],
  session_id = 'default',
  user_id = 'anonymous',
  system_prompt,
}) {
  if (!isConfigured()) {
    throw new Error('Hermes API server not configured');
  }

  const userContent = buildUserContent(message, chart_url, attachments);

  const body = {
    input: [{ role: 'user', content: userContent }],
    conversation_history: buildHistory(history),
    model: 'hermes-agent',
    session_id: sanitizeSessionKey(session_id),
  };
  if (system_prompt) body.instructions = system_prompt;

  const res = await fetch(`${HERMES_URL}/v1/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${HERMES_KEY}`,
      'X-Hermes-Session-Key': `user:${sanitizeSessionKey(user_id)}`,
      'X-Hermes-Session-Id': sanitizeSessionKey(session_id),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      // ignore body read failures
    }
    const err = new Error(`Hermes API server error ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  if (!data.run_id) {
    throw new Error(`Hermes run created without a run_id: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { run_id: data.run_id };
}

/**
 * Resolve a pending approval for a run.
 * @param {string} runId
 * @param {'once'|'session'|'always'|'deny'} choice
 */
async function resolveRunApproval(runId, choice) {
  const res = await fetch(
    `${HERMES_URL}/v1/runs/${encodeURIComponent(runId)}/approval`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${HERMES_KEY}`,
      },
      body: JSON.stringify({ choice }),
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      // ignore body read failures
    }
    const err = new Error(`Hermes approval error ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Parse a chunk of SSE text into complete frames. Each frame is split by a
// blank line; data lines ("data: ...") are collected and JSON-parsed as a
// single event object. Comment frames (": keepalive") are ignored.
function parseSseChunk(buffer) {
  const frames = [];
  let rest = buffer;
  let idx;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let data = '';
    for (const line of frame.split('\n')) {
      const trimmed = line.replace(/\r$/, '');
      if (trimmed.startsWith('data:')) {
        data += (data ? '\n' : '') + trimmed.slice(5).trimStart();
      }
    }
    if (data) {
      try {
        frames.push(JSON.parse(data));
      } catch {
        // ignore malformed frames
      }
    }
  }
  return { frames, rest };
}

/**
 * Async-generator over the SSE event stream for a run. Yields the JSON event
 * objects emitted by Hermes (approval.request, message.delta, run.completed,
 * run.failed, run.cancelled, ...). The stream ends when the run finishes.
 * @param {string} runId
 * @param {number} [timeoutMs] - Overall cap on how long to wait for the run.
 */
async function* getRunEvents(runId, timeoutMs = 15 * 60 * 1000) {
  const res = await fetch(
    `${HERMES_URL}/v1/runs/${encodeURIComponent(runId)}/events`,
    {
      headers: { Authorization: `Bearer ${HERMES_KEY}` },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      // ignore body read failures
    }
    const err = new Error(`Hermes run events error ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = parseSseChunk(buffer);
      buffer = rest;
      for (const frame of frames) yield frame;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore release errors
    }
  }
  // Flush any trailing frame (e.g. final "data:" without a trailing blank).
  if (buffer.trim()) {
    const { frames } = parseSseChunk(buffer + '\n\n');
    for (const frame of frames) yield frame;
  }
}

/**
 * Run a full Hermes chat turn over the /v1/runs API and collect the final
 * reply. Approval requests are delegated to onApproval (if provided), which
 * returns { choice } — anything else defaults to deny (fail closed).
 * @param {Function} [onApproval] - async ({ run_id, event }) => { choice }
 */
async function runChat({
  message,
  history,
  chart_url,
  attachments = [],
  session_id = 'default',
  user_id = 'anonymous',
  system_prompt,
  onApproval,
}) {
  const { run_id } = await createRun({
    message,
    history,
    chart_url,
    attachments,
    session_id,
    user_id,
    system_prompt,
  });

  let reply = '';
  let terminalEvent = null;

  for await (const event of getRunEvents(run_id)) {
    const type = event.event || event.type;
    if (type === 'approval.request') {
      const decision = onApproval
        ? await onApproval({ run_id, event })
        : { choice: 'deny' };
      const choice =
        decision && ['once', 'session', 'always', 'deny'].includes(decision.choice)
          ? decision.choice
          : 'deny';
      try {
        await resolveRunApproval(run_id, choice);
      } catch (err) {
        console.error('[hermes-client] approval resolution failed:', err.message);
        // Continue reading — Hermes treats an unresolved approval as denied.
      }
    } else if (type === 'message.delta') {
      reply += event.delta || '';
    } else if (type === 'run.completed') {
      terminalEvent = event;
      reply = event.output || reply;
    } else if (type === 'run.failed' || type === 'run.cancelled') {
      terminalEvent = event;
    }
  }

  if (terminalEvent && (terminalEvent.event === 'run.failed' || terminalEvent.event === 'run.cancelled')) {
    const err = new Error(terminalEvent.error || `Hermes run ${terminalEvent.event}`);
    err.status = 500;
    throw err;
  }

  return {
    reply: String(reply || '').trim(),
    model_used: 'hermes-agent',
    session_id: session_id || 'default',
  };
}

module.exports = {
  isConfigured,
  chat,
  createRun,
  runChat,
  getRunEvents,
  resolveRunApproval,
  buildHistory,
  buildUserContent,
  NEUTRAL_PIP_SYSTEM,
};
