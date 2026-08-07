// routes/train.js — POST /train: train the co-pilot from uploaded material.
//
// Accepts multipart uploads (PDF strategy documents and/or chart/setup
// images), extracts the text/images, and asks Claude to PROPOSE a strategy-
// profile update. NOTHING is saved by this endpoint — the app shows the
// proposal and lets the user Confirm (POST /strategy applies it), Edit, or
// Discard. TRADING MODE: read-only extraction, no execution, no automation.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const axios = require('axios');
const strategyStore = require('../lib/strategy-store');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 8 },
});

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const MAX_PDF_CHARS = 20000;

function hasApiKey() {
  const key = process.env.CLAUDE_API_KEY || '';
  return (
    key &&
    key !== 'your_key_here' &&
    !key.includes('YOUR_REAL_KEY_HERE') &&
    key.length > 20
  );
}

function isPdf(file) {
  const mime = (file.mimetype || '').toLowerCase();
  return mime === 'application/pdf' || /\.pdf$/i.test(file.originalname || '');
}

function isImage(file) {
  const mime = (file.mimetype || '').toLowerCase();
  return mime.startsWith('image/');
}

async function extractPdfText(buffer) {
  // pdf-parse v2 wants a Uint8Array (Buffer subclass constructor name is
  // rejected), so hand it a view over the same memory.
  const u8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const parser = new PDFParse({ data: u8 });
  try {
    const result = await parser.getText();
    const text = (result && (result.text || result.content) || '').toString().trim();
    return text.slice(0, MAX_PDF_CHARS);
  } finally {
    parser.destroy();
  }
}

function buildExtractionSystemPrompt(currentProfile) {
  return [
    'You are the strategy-import engine of an AI trading co-pilot.',
    'The user uploaded trading documents (PDFs with strategy rules, chart images, setup screenshots).',
    'Extract a PROPOSED strategy profile from them. Output JSON ONLY — no prose, no markdown fences.',
    'The JSON must match this shape:',
    JSON.stringify(
      {
        rules: 'string — consolidated trading rules in natural language (include when extractable)',
        indicators: ['string'],
        preferred_pairs: ['string'],
        timeframes: ['string'],
        setup_description: 'string — what a valid setup looks like',
        risk_tolerance: {
          max_risk_percent: 2,
          max_daily_loss_percent: 5,
          max_correlated_positions: 1,
        },
        summary: 'string — 1-3 sentence plain-language summary of the proposed changes',
      },
      null,
      2,
    ),
    'Rules:',
    '- Only include a field when the documents actually support it; omit fields you cannot extract. summary is always required.',
    '- When the current profile is provided below, describe the DELTA in summary (what changes vs current).',
    '- Never invent specifics that are not in the documents.',
    '- risk_tolerance values must be numbers when present.',
    '',
    'Current profile (may be null):',
    currentProfile ? JSON.stringify(currentProfile) : 'null',
  ].join('\n');
}

function parseProposalJson(text) {
  let cleaned = String(text || '').trim();
  // Strip ```json ... ``` fences if present
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) cleaned = fence[1].trim();
  // Fall back to the first balanced {...} block
  if (!cleaned.startsWith('{')) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  }
  try {
    const obj = JSON.parse(cleaned);
    return typeof obj === 'object' && obj !== null && !Array.isArray(obj)
      ? obj
      : { parse_error: 'Proposal was not a JSON object' };
  } catch (err) {
    return { parse_error: 'Could not parse proposal as JSON', raw: String(text || '').slice(0, 4000) };
  }
}

// POST /train — multipart form field "files" (PDFs and/or images).
router.post('/', (req, res, next) => {
  upload.array('files', 8)(req, res, async (err) => {
    try {
      if (err) {
        return res.status(400).json({ error: `Upload failed: ${err.message}` });
      }

      const user_id = req.userId;
      const files = req.files || [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'Upload at least one PDF or image' });
      }
      if (!hasApiKey()) {
        return res.status(400).json({
          error: 'The backend has no Claude API key configured. Add CLAUDE_API_KEY to the server .env to use Train mode.',
        });
      }

      const sources = [];
      const contentBlocks = [];

      for (const file of files) {
        try {
          if (isPdf(file)) {
            const text = await extractPdfText(file.buffer);
            if (!text) {
              sources.push({ name: file.originalname, type: 'pdf', status: 'no extractable text' });
              continue;
            }
            sources.push({ name: file.originalname, type: 'pdf', status: 'ok', chars: text.length });
            contentBlocks.push({
              type: 'text',
              text: `--- PDF: ${file.originalname} ---\n${text}`,
            });
          } else if (isImage(file)) {
            const mediaType = (file.mimetype || 'image/jpeg').toLowerCase();
            sources.push({ name: file.originalname, type: 'image', status: 'ok', bytes: file.size });
            contentBlocks.push({
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: file.buffer.toString('base64') },
            });
          } else {
            sources.push({ name: file.originalname, type: 'unknown', status: 'skipped (not a PDF or image)' });
          }
        } catch (fileErr) {
          sources.push({ name: file.originalname, type: isPdf(file) ? 'pdf' : 'unknown', status: `error: ${fileErr.message}` });
        }
      }

      if (contentBlocks.length === 0) {
        return res.status(400).json({ error: 'No usable content extracted from the uploads', sources });
      }

      const current = strategyStore.getProfile(user_id);
      const { data } = await axios.post(
        ANTHROPIC_URL,
        {
          model: MODEL,
          max_tokens: 2000,
          system: buildExtractionSystemPrompt(current ? current.profile : null),
          messages: [{ role: 'user', content: contentBlocks }],
        },
        {
          headers: {
            'x-api-key': process.env.CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 90000,
        },
      );

      const text = (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      res.json({
        proposed: parseProposalJson(text),
        sources,
        current_profile: current ? current.profile : null,
        llm: 'claude',
      });
    } catch (routeErr) {
      next(routeErr);
    }
  });
});

module.exports = router;
module.exports.parseProposalJson = parseProposalJson;
