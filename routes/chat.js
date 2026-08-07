// TRADING MODE: this is the ONLY path through which trading chat is analyzed.
// Never performs on-screen automation. Trade execution is server-side only.

const express = require('express');
const router = express.Router();
const hermesClient = require('../lib/hermes-client');
const { checkUsageCap, incrementUsage } = require('../lib/usage-caps');
const { looksLikeCredentials } = require('../lib/credential-guard');

router.post('/', async (req, res) => {
  const { message, history = [], attachments = [], chart_url, session_id = 'default' } = req.body || {};

  console.log('[chat] message:', message?.slice(0, 100));
  console.log('[chat] history length:', history.length);
  console.log('[chat] attachments count:', attachments.length);
  console.log('[chat] chart_url:', chart_url ? 'yes' : 'none');
  console.log('[chat] session_id:', session_id);

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  // Task 5 safety net: refuse to forward credential-shaped content to Hermes,
  // where it could be persisted in conversation memory. This is a coarse
  // heuristic — the structural boundary (MCP tools never accept credentials)
  // is the real defense. Users must connect accounts via the app's Connect
  // Trading Accounts screen, which posts credentials once to encrypted
  // storage and never shows them to the LLM.
  if (looksLikeCredentials(message)) {
    return res.status(200).json({
      reply:
        '[Neutral Pip] Don\'t share account passwords or login credentials in ' +
        'chat — anything typed here becomes part of the conversation memory. ' +
        'Use the app\'s Settings → Connect Trading Accounts screen instead, ' +
        'which stores your credentials encrypted and never exposes them to the AI.',
    });
  }

  // user_id is always resolved server-side from the Bearer session token —
  // the client never sends it. Falls back to 'anonymous' for unauthenticated
  // chat (default-key / guest usage).
  let userId = 'anonymous';
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const session = require('../lib/auth').resolveSession(authHeader.slice(7).trim());
    if (session && session.user_id) userId = session.user_id;
  }

  // Authenticated users must activate their agent before the chat assistant
  // will respond. Anonymous (guest) chat is unaffected.
  if (userId !== 'anonymous' && !require('../lib/auth').isAgentActive(userId)) {
    return res.status(200).json({
      reply:
        '[Neutral Pip] Your agent is paused. Open the app and activate your agent to resume chat, analysis and alarms.',
      activation_required: true,
    });
  }

  // Hermes is the ONLY LLM backend for /chat — the legacy Anthropic path has
  // been retired. When Hermes is not configured, the server responds with a
  // clear message; the app itself falls back to direct-LLM calls on its own.
  const hermesConfigured = hermesClient.isConfigured();
  if (!hermesConfigured) {
    return res.status(200).json({
      reply:
        '[Neutral Pip] This server has no AI backend configured. Open the app Settings → AI Engine Configuration and add a direct key, or ask the operator to set HERMES_API_SERVER_URL on the server.',
    });
  }

  // Shared Hermes instance counts as default-key usage: cap everyone.
  const capCheck = checkUsageCap(userId);
  if (!capCheck.allowed) {
    return res.status(200).json({
      reply: `[Neutral Pip] ${capCheck.reason} (${capCheck.calls}/${capCheck.callLimit} calls, ${capCheck.tokens}/${capCheck.tokenLimit} tokens today)`
    });
  }

  try {
    // Trade-capable turns MUST go through the /v1/runs API so approval.request
    // events (e.g. the MT5 trade approval) reach the backend and can be
    // resolved. The synchronous chat-completions path would fail closed on any
    // elicitation, silently denying legit trades.
    let result;
    try {
      result = await hermesClient.runChat({
        message,
        history,
        chart_url,
        attachments,
        session_id,
        user_id: userId,
        system_prompt: hermesClient.buildSystemPrompt(userId),
        onApproval: async ({ run_id, event }) => {
          const decision = await require('../lib/trade-approval').decideTradeApproval({
            command: event.command,
            fallbackUser: userId,
          });
          console.log(
            `[chat] approval decision for run ${run_id}: ${decision.choice} — ${decision.reason}`,
          );
          return { choice: decision.choice };
        },
      });
    } catch (err) {
      // If the runs API itself is unavailable (older Hermes, 404/405/501),
      // fall back to the synchronous chat-completions path. Any approval
      // needed there fails closed, which is the safe default.
      if ([404, 405, 501].includes(err.status)) {
        result = await hermesClient.chat({
          message,
          history,
          chart_url,
          attachments,
          session_id,
          user_id: userId,
          system_prompt: hermesClient.buildSystemPrompt(userId),
        });
      } else {
        throw err;
      }
    }

    // Track usage for shared/default key users.
    const estimatedTokens = Math.ceil((message.length + result.reply.length) / 4);
    incrementUsage(userId, estimatedTokens);

    res.json({
      reply: result.reply,
      model_used: result.model_used,
      session_id: result.session_id,
      using_default_key: true,
    });

  } catch (err) {
    console.error('[chat] Agent error:', err.message);

    if (err.message && err.message.includes('401')) {
      return res.status(200).json({ reply: '[Neutral Pip] Invalid API key. Check your key in Settings.' });
    }
    if (err.message && err.message.includes('429')) {
      return res.status(200).json({ reply: '[Neutral Pip] Rate limited — wait a moment and try again.' });
    }

    // Generic error handling
    res.status(500).json({ error: 'AI call failed', detail: err.message });
  }
});

module.exports = router;
