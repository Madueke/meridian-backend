// store.js — tiny file-backed JSON store with atomic writes.
//
// Collections live in data/store.json under their own keys. Each write goes
// through a temp file + rename so a crash mid-write can't corrupt the store.
// This is intentionally dependency-free; swap for Postgres/Redis when the
// backend grows real multi-instance needs.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

/** Read a collection (or a single key within it). */
function get(collection, key) {
  const data = load();
  const col = data[collection];
  if (key === undefined) return col;
  return col ? col[key] : undefined;
}

/** Set a single key within a collection. */
function set(collection, key, value) {
  const data = load();
  if (!data[collection]) data[collection] = {};
  data[collection][key] = value;
  persist();
}

/** Update a single key within a collection via a mutating callback. */
function update(collection, key, fn) {
  const data = load();
  if (!data[collection]) data[collection] = {};
  const current = data[collection][key];
  data[collection][key] = fn(current);
  persist();
}

function remove(collection, key) {
  const data = load();
  if (data[collection]) {
    delete data[collection][key];
    persist();
  }
}

/** List all keys in a collection. */
function keys(collection) {
  const data = load();
  return data[collection] ? Object.keys(data[collection]) : [];
}

module.exports = { get, set, update, remove, keys, _file: STORE_FILE };
