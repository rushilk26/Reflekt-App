require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'default-secret';

// --- Token Auth with user_id ---
// Map<token, { userId, expiry }>
const activeSessions = new Map();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || !activeSessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const session = activeSessions.get(token);
  if (Date.now() > session.expiry) {
    activeSessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }
  session.expiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
  req.userId = session.userId;
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of activeSessions) {
    if (now > session.expiry) activeSessions.delete(token);
  }
}, 60 * 60 * 1000);

// --- Database ---
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

async function initDB() {
  // Create users table
  await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    email TEXT DEFAULT '',
    reset_token TEXT DEFAULT '',
    reset_token_expiry INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  // Add email/reset columns if upgrading from old schema
  try { await db.execute('ALTER TABLE users ADD COLUMN email TEXT DEFAULT ""'); } catch(e) {}
  try { await db.execute('ALTER TABLE users ADD COLUMN reset_token TEXT DEFAULT ""'); } catch(e) {}
  try { await db.execute('ALTER TABLE users ADD COLUMN reset_token_expiry INTEGER DEFAULT 0'); } catch(e) {}

  // Check if old schema (no user_id) exists and migrate
  let needsMigration = false;
  try {
    const info = await db.execute("PRAGMA table_info(entries)");
    const cols = info.rows.map(r => r.name);
    if (cols.length > 0 && !cols.includes('user_id')) {
      needsMigration = true;
    }
  } catch (e) { /* table doesn't exist yet, fine */ }

  if (needsMigration) {
    console.log('🔄 Migrating old schema to multi-user...');
    // Seed original user first
    const hash = await bcrypt.hash(process.env.APP_PASSWORD || '83r9ddj26', 10);
    await db.execute({ sql: 'INSERT OR IGNORE INTO users (username, password_hash, display_name) VALUES (?, ?, ?)', args: ['rushil', hash, 'Rushil'] });
    const userResult = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: ['rushil'] });
    const uid = Number(userResult.rows[0].id);

    // Rename old tables, create new ones, copy data with user_id
    await db.executeMultiple(`
      ALTER TABLE entries RENAME TO entries_old;
      ALTER TABLE excerpts RENAME TO excerpts_old;
      ALTER TABLE summaries RENAME TO summaries_old;

      CREATE TABLE entries (
        user_id INTEGER NOT NULL, date TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, date)
      );
      CREATE TABLE excerpts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        text TEXT NOT NULL, topic TEXT NOT NULL DEFAULT 'Uncategorized',
        source_date TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE summaries (
        user_id INTEGER NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, key)
      );
    `);

    // Copy data
    await db.execute({ sql: `INSERT INTO entries (user_id, date, body, tags, created_at, updated_at) SELECT ?, date, body, tags, created_at, updated_at FROM entries_old`, args: [uid] });
    await db.execute({ sql: `INSERT INTO excerpts (user_id, text, topic, source_date, created_at) SELECT ?, text, topic, source_date, created_at FROM excerpts_old`, args: [uid] });
    await db.execute({ sql: `INSERT INTO summaries (user_id, key, text, created_at) SELECT ?, key, text, created_at FROM summaries_old`, args: [uid] });

    // Drop old tables
    await db.executeMultiple(`DROP TABLE entries_old; DROP TABLE excerpts_old; DROP TABLE summaries_old;`);
    console.log('✅ Migration complete — all data assigned to user:', uid);
  } else {
    // Fresh or already migrated — just ensure tables exist
    await db.executeMultiple(`
      CREATE TABLE IF NOT EXISTS entries (
        user_id INTEGER NOT NULL, date TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, date)
      );
      CREATE TABLE IF NOT EXISTS excerpts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        text TEXT NOT NULL, topic TEXT NOT NULL DEFAULT 'Uncategorized',
        source_date TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS summaries (
        user_id INTEGER NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, key)
      );
    `);

    // Ensure original user exists
    const existing = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: ['rushil'] });
    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash(process.env.APP_PASSWORD || '83r9ddj26', 10);
      await db.execute({ sql: 'INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)', args: ['rushil', hash, 'Rushil'] });
      console.log('✅ Created original user account');
    }
  }
}

// --- Middleware ---
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Pending Signups (email verification) ---
// Map<email, { username, passwordHash, displayName, code, expiry }>
const pendingSignups = new Map();

async function sendVerificationEmail(email, code) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Reflekt <noreply@reflektapp.co.in>',
      to: [email],
      subject: 'Your Reflekt verification code',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 20px">
        <h2 style="color:#2D1F14;font-size:22px">Verify your email</h2>
        <p style="color:#6B5B4E;line-height:1.6">Enter this code in Reflekt to create your account:</p>
        <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#C4704B;margin:24px 0;text-align:center">${code}</div>
        <p style="color:#9B8B7E;font-size:13px">This code expires in 10 minutes. If you didn't sign up for Reflekt, you can ignore this.</p>
      </div>`
    })
  });
  return res.ok;
}

// Clean up expired pending signups every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [email, data] of pendingSignups) {
    if (now > data.expiry) pendingSignups.delete(email);
  }
}, 5 * 60 * 1000);

// --- Auth Routes ---

// Step 1: Validate info + send verification code
app.post('/api/signup/send-code', async (req, res) => {
  try {
    const { username, password, displayName, email } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email is required' });
    if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });

    const exists = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username.toLowerCase()] });
    if (exists.rows.length > 0) return res.status(409).json({ error: 'Username already taken' });

    const emailExists = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email.toLowerCase()] });
    if (emailExists.rows.length > 0) return res.status(409).json({ error: 'Email already registered' });

    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
    const hash = await bcrypt.hash(password, 10);
    pendingSignups.set(email.toLowerCase(), {
      username: username.toLowerCase(),
      passwordHash: hash,
      displayName: displayName || username,
      code,
      expiry: Date.now() + 10 * 60 * 1000 // 10 minutes
    });

    const sent = await sendVerificationEmail(email, code);
    if (!sent) return res.status(500).json({ error: 'Failed to send verification email. Try again.' });
    res.json({ success: true, message: 'Verification code sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 2: Verify code + create account
app.post('/api/signup/verify', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

    const pending = pendingSignups.get(email.toLowerCase());
    if (!pending) return res.status(400).json({ error: 'No pending signup found. Please start over.' });
    if (Date.now() > pending.expiry) {
      pendingSignups.delete(email.toLowerCase());
      return res.status(400).json({ error: 'Code expired. Please start over.' });
    }
    if (pending.code !== code.trim()) return res.status(400).json({ error: 'Incorrect code. Try again.' });

    // Code matches — create the account
    const result = await db.execute({
      sql: 'INSERT INTO users (username, password_hash, display_name, email) VALUES (?, ?, ?, ?)',
      args: [pending.username, pending.passwordHash, pending.displayName, email.toLowerCase()]
    });

    pendingSignups.delete(email.toLowerCase());
    const userId = Number(result.lastInsertRowid);
    const token = generateToken();
    activeSessions.set(token, { userId, expiry: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, token, username: pending.username });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Username or email already taken' });
    res.status(500).json({ error: err.message });
  }
});

// Legacy single-step signup (keep for backward compat)
app.post('/api/signup', async (req, res) => {
  res.status(400).json({ error: 'Please use the updated signup flow' });
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const result = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username.toLowerCase()] });
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid username or password' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

    const token = generateToken();
    activeSessions.set(token, { userId: Number(user.id), expiry: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, token, username: user.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) activeSessions.delete(token);
  res.json({ success: true });
});

app.get('/api/check-auth', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token && activeSessions.has(token)) {
    const session = activeSessions.get(token);
    if (Date.now() <= session.expiry) {
      session.expiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
      return res.json({ authenticated: true });
    }
    activeSessions.delete(token);
  }
  res.json({ authenticated: false });
});

// --- Password Reset ---
async function sendResetEmail(email, resetUrl) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Reflekt <noreply@reflektapp.co.in>',
      to: [email],
      subject: 'Reset your Reflekt password',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 20px">
        <h2 style="color:#2D1F14;font-size:22px">Reset your password</h2>
        <p style="color:#6B5B4E;line-height:1.6">We received a request to reset your Reflekt password. Click the button below to set a new one. This link expires in 1 hour.</p>
        <a href="${resetUrl}" style="display:inline-block;padding:12px 28px;background:#C4704B;color:white;text-decoration:none;border-radius:6px;font-weight:500;margin:20px 0">Reset Password</a>
        <p style="color:#9B8B7E;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
      </div>`
    })
  });
  return res.ok;
}

app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const result = await db.execute({ sql: 'SELECT id, email FROM users WHERE email = ?', args: [email.toLowerCase()] });
    // Always return success to prevent email enumeration
    if (result.rows.length === 0) return res.json({ success: true });
    const user = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    await db.execute({ sql: 'UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?', args: [resetToken, expiry, user.id] });
    const resetUrl = `${APP_URL}/reset-password.html?token=${resetToken}`;
    await sendResetEmail(user.email, resetUrl);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const now = Math.floor(Date.now() / 1000);
    const result = await db.execute({ sql: 'SELECT id FROM users WHERE reset_token = ? AND reset_token_expiry > ?', args: [token, now] });
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    const userId = result.rows[0].id;
    const hash = await bcrypt.hash(password, 10);
    await db.execute({ sql: 'UPDATE users SET password_hash = ?, reset_token = \'\', reset_token_expiry = 0 WHERE id = ?', args: [hash, userId] });
    // Invalidate all sessions for this user
    for (const [tok, session] of activeSessions) {
      if (session.userId === Number(userId)) activeSessions.delete(tok);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Update email for existing user
app.put('/api/profile', authMiddleware, async (req, res) => {
  try {
    const { email } = req.body;
    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
      await db.execute({ sql: 'UPDATE users SET email = ? WHERE id = ?', args: [email.toLowerCase(), req.userId] });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Protected Routes (all scoped to req.userId) ---

// ENTRIES
app.get('/api/entries', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM entries WHERE user_id = ? ORDER BY date DESC', args: [req.userId] });
    const entries = {};
    result.rows.forEach(r => {
      entries[r.date] = { body: r.body, tags: JSON.parse(r.tags), date: r.date, updatedAt: r.updated_at };
    });
    res.json(entries);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/entries/:date', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM entries WHERE user_id = ? AND date = ?', args: [req.userId, req.params.date] });
    if (result.rows.length === 0) return res.json(null);
    const r = result.rows[0];
    res.json({ body: r.body, tags: JSON.parse(r.tags), date: r.date, updatedAt: r.updated_at });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/entries/:date', authMiddleware, async (req, res) => {
  try {
    const { body, tags } = req.body;
    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: `INSERT INTO entries (user_id, date, body, tags, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, date) DO UPDATE SET body = excluded.body, tags = excluded.tags, updated_at = excluded.updated_at`,
      args: [req.userId, req.params.date, body || '', JSON.stringify(tags || []), now, now]
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/entries/:date', authMiddleware, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM entries WHERE user_id = ? AND date = ?', args: [req.userId, req.params.date] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// EXCERPTS
app.get('/api/excerpts', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM excerpts WHERE user_id = ? ORDER BY created_at DESC', args: [req.userId] });
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/excerpts', authMiddleware, async (req, res) => {
  try {
    const { text, topic, source_date } = req.body;
    const result = await db.execute({
      sql: 'INSERT INTO excerpts (user_id, text, topic, source_date) VALUES (?, ?, ?, ?)',
      args: [req.userId, text, topic || 'Uncategorized', source_date || '']
    });
    res.json({ id: Number(result.lastInsertRowid), success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/excerpts/:id', authMiddleware, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM excerpts WHERE id = ? AND user_id = ?', args: [parseInt(req.params.id), req.userId] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SUMMARIES
app.get('/api/summaries', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM summaries WHERE user_id = ? ORDER BY created_at DESC', args: [req.userId] });
    const summaries = {};
    result.rows.forEach(r => { summaries[r.key] = { text: r.text, createdAt: r.created_at }; });
    res.json(summaries);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/summaries/:key', authMiddleware, async (req, res) => {
  try {
    const { text } = req.body;
    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: `INSERT INTO summaries (user_id, key, text, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, key) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`,
      args: [req.userId, req.params.key, text, now]
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/summaries/:key', authMiddleware, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM summaries WHERE user_id = ? AND key = ?', args: [req.userId, decodeURIComponent(req.params.key)] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// STATS
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const countResult = await db.execute({ sql: 'SELECT COUNT(*) as count FROM entries WHERE user_id = ?', args: [req.userId] });
    const totalEntries = Number(countResult.rows[0].count);

    const bodyResult = await db.execute({ sql: 'SELECT body FROM entries WHERE user_id = ?', args: [req.userId] });
    let totalWords = 0;
    bodyResult.rows.forEach(r => {
      const text = r.body.replace(/<[^>]*>/g, '');
      totalWords += text.split(/\s+/).filter(w => w).length;
    });

    let streak = 0;
    const today = new Date();
    while (true) {
      const y = today.getFullYear();
      const m = String(today.getMonth() + 1).padStart(2, '0');
      const d = String(today.getDate()).padStart(2, '0');
      const key = `${y}-${m}-${d}`;
      const exists = await db.execute({ sql: 'SELECT 1 FROM entries WHERE user_id = ? AND date = ?', args: [req.userId, key] });
      if (exists.rows.length > 0) { streak++; today.setDate(today.getDate() - 1); }
      else break;
    }

    const avgWords = totalEntries ? Math.round(totalWords / totalEntries) : 0;
    res.json({ totalEntries, totalWords, streak, avgWords });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// TAGS
app.get('/api/tags', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT tags FROM entries WHERE user_id = ?', args: [req.userId] });
    const tagSet = new Set();
    result.rows.forEach(r => { JSON.parse(r.tags).forEach(t => tagSet.add(t)); });
    res.json([...tagSet].sort());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CLAUDE API PROXY
app.post('/api/claude', authMiddleware, async (req, res) => {
  if (!CLAUDE_API_KEY) return res.status(400).json({ error: 'Claude API key not configured.' });
  try {
    const { prompt, system } = req.body;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, system: system || 'You are a thoughtful journal assistant.', messages: [{ role: 'user', content: prompt }] })
    });
    if (!response.ok) { const err = await response.json().catch(() => ({})); return res.status(response.status).json({ error: err.error?.message || `API error: ${response.status}` }); }
    const data = await response.json();
    res.json({ text: data.content[0].text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/claude-chat', authMiddleware, async (req, res) => {
  if (!CLAUDE_API_KEY) return res.status(400).json({ error: 'Claude API key not configured.' });
  try {
    const { messages, system } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid messages.' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: system || 'You are a thoughtful journal companion.', messages })
    });
    if (!response.ok) { const err = await response.json().catch(() => ({})); return res.status(response.status).json({ error: err.error?.message || `API error: ${response.status}` }); }
    const data = await response.json();
    res.json({ text: data.content[0].text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// EXPORT
app.get('/api/export', authMiddleware, async (req, res) => {
  try {
    const entries = {};
    const entryResult = await db.execute({ sql: 'SELECT * FROM entries WHERE user_id = ?', args: [req.userId] });
    entryResult.rows.forEach(r => { entries[r.date] = { body: r.body, tags: JSON.parse(r.tags), date: r.date }; });
    const excerptResult = await db.execute({ sql: 'SELECT * FROM excerpts WHERE user_id = ? ORDER BY created_at DESC', args: [req.userId] });
    const summaries = {};
    const summaryResult = await db.execute({ sql: 'SELECT * FROM summaries WHERE user_id = ?', args: [req.userId] });
    summaryResult.rows.forEach(r => { summaries[r.key] = { text: r.text }; });
    res.json({ entries, excerpts: excerptResult.rows, summaries, exportedAt: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// IMPORT
app.post('/api/import', authMiddleware, async (req, res) => {
  try {
    const { entries, excerpts, summaries } = req.body;
    const now = Math.floor(Date.now() / 1000);
    const statements = [];
    if (entries) {
      for (const date of Object.keys(entries)) {
        const e = entries[date];
        statements.push({ sql: `INSERT INTO entries (user_id, date, body, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET body = excluded.body, tags = excluded.tags, updated_at = excluded.updated_at`, args: [req.userId, date, e.body || '', JSON.stringify(e.tags || []), now, now] });
      }
    }
    if (excerpts) {
      for (const e of excerpts) {
        statements.push({ sql: 'INSERT INTO excerpts (user_id, text, topic, source_date, created_at) VALUES (?, ?, ?, ?, ?)', args: [req.userId, e.text, e.topic || 'Uncategorized', e.source_date || '', now] });
      }
    }
    if (summaries) {
      for (const key of Object.keys(summaries)) {
        statements.push({ sql: `INSERT INTO summaries (user_id, key, text, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET text = excluded.text`, args: [req.userId, key, summaries[key].text, now] });
      }
    }
    if (statements.length > 0) await db.batch(statements, 'write');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEED IMPORT (temporary, key-based)
app.post('/api/import-seed', async (req, res) => {
  const key = req.headers['x-import-key'];
  if (key !== (process.env.SESSION_SECRET || 'reflekt_s3cr3t_k3y_2026')) return res.status(401).json({ error: 'Invalid import key' });
  const targetUser = req.headers['x-user-id'] || '1';
  try {
    const { entries, excerpts, summaries } = req.body;
    const now = Math.floor(Date.now() / 1000);
    const uid = parseInt(targetUser);
    const statements = [];
    if (entries) {
      for (const date of Object.keys(entries)) {
        const e = entries[date];
        statements.push({ sql: `INSERT INTO entries (user_id, date, body, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET body = excluded.body, tags = excluded.tags, updated_at = excluded.updated_at`, args: [uid, date, e.body || '', JSON.stringify(e.tags || []), now, now] });
      }
    }
    if (excerpts) {
      for (const e of excerpts) {
        statements.push({ sql: 'INSERT INTO excerpts (user_id, text, topic, source_date, created_at) VALUES (?, ?, ?, ?, ?)', args: [uid, e.text, e.topic || 'Uncategorized', e.source_date || '', now] });
      }
    }
    if (summaries) {
      for (const k of Object.keys(summaries)) {
        statements.push({ sql: `INSERT INTO summaries (user_id, key, text, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET text = excluded.text`, args: [uid, k, summaries[k].text, now] });
      }
    }
    if (statements.length > 0) await db.batch(statements, 'write');
    res.json({ success: true, imported: statements.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SPA fallback
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// --- Start ---
initDB().then(() => {
  app.listen(PORT, () => { console.log(`✨ Reflekt Journal running at http://localhost:${PORT}`); });
}).catch(err => { console.error('Failed to initialize database:', err); process.exit(1); });
