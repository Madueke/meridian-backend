// lib/hermes-memory.js — Hermes-style three-layer memory system.
// TRADING MODE: this module is read-only to the LLM layer — the LLM never
// writes directly to this store; only backend code writes here based on
// verified trade outcomes.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'hermes.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db = null;

function initDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  
  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  
  // Sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      last_active INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
  
  // Memories table
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    )
  `);
  
  // Skills table
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      use_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
      UNIQUE(session_id, name)
    )
  `);
  
  // Indexes for common queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_skills_session ON skills(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at)`);
  
  return db;
}

function getOrCreateSession(sessionId, userId) {
  if (!db) initDb();
  
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO sessions (session_id, user_id, created_at, last_active)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      last_active = excluded.last_active,
      user_id = COALESCE(excluded.user_id, user_id)
    RETURNING *
  `);
  
  return stmt.get(sessionId, userId, now, now);
}

function saveMemory(sessionId, type, content) {
  if (!db) initDb();
  
  const stmt = db.prepare(`
    INSERT INTO memories (session_id, type, content, created_at)
    VALUES (?, ?, ?, ?)
  `);
  
  const now = Date.now();
  stmt.run(sessionId, type, content, now);
  
  // Update session last_active
  db.prepare('UPDATE sessions SET last_active = ? WHERE session_id = ?').run(now, sessionId);
}

function getRecentMemories(sessionId, limit = 10) {
  if (!db) initDb();
  
  const stmt = db.prepare(`
    SELECT id, type, content, created_at
    FROM memories
    WHERE session_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  
  return stmt.all(sessionId, limit);
}

function getSkills(sessionId) {
  if (!db) initDb();
  
  const stmt = db.prepare(`
    SELECT id, name, description, content, use_count, created_at, updated_at
    FROM skills
    WHERE session_id = ?
    ORDER BY use_count DESC
  `);
  
  return stmt.all(sessionId);
}

function saveSkill(sessionId, name, description, content) {
  if (!db) initDb();
  
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO skills (session_id, name, description, content, use_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(session_id, name) DO UPDATE SET
      description = excluded.description,
      content = excluded.content,
      updated_at = excluded.updated_at,
      use_count = use_count + 1
  `);
  
  stmt.run(sessionId, name, description, content, now, now);
}

function incrementSkillUse(sessionId, name) {
  if (!db) initDb();
  
  const stmt = db.prepare(`
    UPDATE skills
    SET use_count = use_count + 1,
        updated_at = ?
    WHERE session_id = ? AND name = ?
  `);
  
  stmt.run(Date.now(), sessionId, name);
}

function buildContextBlock(sessionId) {
  if (!db) initDb();
  
  const memories = getRecentMemories(sessionId, 8);
  const skills = getSkills(sessionId);
  
  if (memories.length === 0 && skills.length === 0) {
    return '';
  }
  
  let block = '--- Neutral Pip memory for this session ---\n';
  
  if (memories.length > 0) {
    for (const mem of memories) {
      block += `[${mem.type}] ${mem.content}\n`;
    }
  }
  
  if (skills.length > 0) {
    for (const skill of skills) {
      block += `[skill] ${skill.name}: ${skill.description}\n`;
    }
  }
  
  block += '--- End memory ---';
  return block;
}

module.exports = {
  initDb,
  getOrCreateSession,
  saveMemory,
  getRecentMemories,
  getSkills,
  saveSkill,
  incrementSkillUse,
  buildContextBlock,
};