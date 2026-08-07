// TRADING MODE: this is the ONLY path through which trading chat is analyzed.
// Never performs on-screen automation. Trade execution is server-side only.

const express = require('express');
const router = express.Router();
const neutralPipAgent = require('../lib/neutral-pip-agent');
const { 
  getDefaultApiKey, 
  hasUserApiKey, 
  checkUsageCap, 
  incrementUsage 
} = require('../lib/usage-caps');

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

  // user_id is always resolved server-side from the Bearer session token —
  // the client never sends it. Falls back to 'anonymous' for unauthenticated
  // chat (default-key / guest usage).
  let userId = 'anonymous';
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const session = require('../lib/auth').resolveSession(authHeader.slice(7).trim());
    if (session && session.user_id) userId = session.user_id;
  }

  // Determine API key: user's own key (from header) takes priority
  const userApiKey = req.headers['x-api-key'];
  const hasOwnKey = userApiKey && userApiKey !== 'your_key_here';
  
  let apiKey;
  let usingDefaultKey = false;
  
  if (hasOwnKey) {
    apiKey = userApiKey;
  } else {
    // Fall back to server default key
    apiKey = getDefaultApiKey();
    usingDefaultKey = !!apiKey;
  }
  
  // Get model from header x-model OR default 'claude-sonnet-4-6'
  const model = req.headers['x-model'] || 'claude-sonnet-4-6';

  if (!apiKey || apiKey === 'your_key_here') {
    return res.status(200).json({ 
      reply: '[Neutral Pip] No API key configured. Open the app Settings → AI Engine Configuration and add your Claude or OpenRouter key, then set the backend URL to this server.' 
    });
  }

  // If using default key, check usage cap
  if (usingDefaultKey) {
    const capCheck = checkUsageCap(userId);
    if (!capCheck.allowed) {
      return res.status(200).json({ 
        reply: `[Neutral Pip] ${capCheck.reason} (${capCheck.calls}/${capCheck.callLimit} calls, ${capCheck.tokens}/${capCheck.tokenLimit} tokens today)` 
      });
    }
  }

  try {
    const result = await neutralPipAgent.runAgent({
      message,
      history,
      chart_url,
      attachments,
      session_id,
      user_id: userId,
      api_key: apiKey,
      model,
    });

    // Track usage for default key users
    if (usingDefaultKey) {
      // Estimate tokens: rough approximation (1 token ≈ 4 chars)
      const estimatedTokens = Math.ceil((message.length + result.reply.length) / 4);
      incrementUsage(userId, estimatedTokens);
    }

    res.json({ 
      reply: result.reply, 
      model_used: result.model_used, 
      session_id: result.session_id,
      using_default_key: usingDefaultKey,
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