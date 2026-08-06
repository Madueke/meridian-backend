// TRADING MODE: this is the ONLY path through which trading chat is analyzed.
// Never performs on-screen automation. Trade execution is server-side only.

const express = require('express');
const router = express.Router();
const neutralPipAgent = require('../lib/neutral-pip-agent');

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

  // Get api_key from header x-api-key OR from process.env.CLAUDE_API_KEY (fallback)
  const apiKey = req.headers['x-api-key'] || process.env.CLAUDE_API_KEY;
  
  // Get model from header x-model OR default 'claude-sonnet-4-6'
  const model = req.headers['x-model'] || 'claude-sonnet-4-6';
  
  // Get user_id from the Bearer token if auth middleware has set req.user, else use 'anonymous'
  const userId = req.user?.user_id || 'anonymous';

  if (!apiKey || apiKey === 'your_key_here') {
    return res.status(200).json({ 
      reply: '[Neutral Pip] No API key configured. Open the app Settings → AI Engine Configuration and add your Claude or OpenRouter key, then set the backend URL to this server.' 
    });
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

    res.json({ 
      reply: result.reply, 
      model_used: result.model_used, 
      session_id: result.session_id 
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