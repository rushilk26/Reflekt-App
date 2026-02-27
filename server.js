require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';

// --- Database Setup (Turso / libSQL) ---
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

async function initDB() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS entries (
      date TEXT PRIMARY KEY,
      body TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS excerpts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT 'Uncategorized',
      source_date TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS summaries (
      key TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}

// --- Middleware ---
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- API Routes ---

// ENTRIES
app.get('/api/entries', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM entries ORDER BY date DESC');
    const entries = {};
    result.rows.forEach(r => {
      entries[r.date] = { body: r.body, tags: JSON.parse(r.tags), date: r.date, updatedAt: r.updated_at };
    });
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/entries/:date', async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM entries WHERE date = ?', args: [req.params.date] });
    if (result.rows.length === 0) return res.json(null);
    const r = result.rows[0];
    res.json({ body: r.body, tags: JSON.parse(r.tags), date: r.date, updatedAt: r.updated_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/entries/:date', async (req, res) => {
  try {
    const { body, tags } = req.body;
    const date = req.params.date;
    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: `INSERT INTO entries (date, body, tags, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET body = excluded.body, tags = excluded.tags, updated_at = excluded.updated_at`,
      args: [date, body || '', JSON.stringify(tags || []), now, now]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/entries/:date', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM entries WHERE date = ?', args: [req.params.date] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EXCERPTS
app.get('/api/excerpts', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM excerpts ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/excerpts', async (req, res) => {
  try {
    const { text, topic, source_date } = req.body;
    const result = await db.execute({
      sql: 'INSERT INTO excerpts (text, topic, source_date) VALUES (?, ?, ?)',
      args: [text, topic || 'Uncategorized', source_date || '']
    });
    res.json({ id: Number(result.lastInsertRowid), success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/excerpts/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM excerpts WHERE id = ?', args: [parseInt(req.params.id)] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SUMMARIES
app.get('/api/summaries', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM summaries ORDER BY created_at DESC');
    const summaries = {};
    result.rows.forEach(r => { summaries[r.key] = { text: r.text, createdAt: r.created_at }; });
    res.json(summaries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/summaries/:key', async (req, res) => {
  try {
    const { text } = req.body;
    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: `INSERT INTO summaries (key, text, created_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`,
      args: [req.params.key, text, now]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/summaries/:key', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM summaries WHERE key = ?', args: [decodeURIComponent(req.params.key)] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// STATS
app.get('/api/stats', async (req, res) => {
  try {
    const countResult = await db.execute('SELECT COUNT(*) as count FROM entries');
    const totalEntries = Number(countResult.rows[0].count);

    const bodyResult = await db.execute('SELECT body FROM entries');
    let totalWords = 0;
    bodyResult.rows.forEach(r => {
      const text = r.body.replace(/<[^>]*>/g, '');
      totalWords += text.split(/\s+/).filter(w => w).length;
    });

    // Calculate streak
    let streak = 0;
    const today = new Date();
    while (true) {
      const y = today.getFullYear();
      const m = String(today.getMonth() + 1).padStart(2, '0');
      const d = String(today.getDate()).padStart(2, '0');
      const key = `${y}-${m}-${d}`;
      const exists = await db.execute({ sql: 'SELECT 1 FROM entries WHERE date = ?', args: [key] });
      if (exists.rows.length > 0) { streak++; today.setDate(today.getDate() - 1); }
      else break;
    }

    const avgWords = totalEntries ? Math.round(totalWords / totalEntries) : 0;
    res.json({ totalEntries, totalWords, streak, avgWords });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ALL TAGS
app.get('/api/tags', async (req, res) => {
  try {
    const result = await db.execute('SELECT tags FROM entries');
    const tagSet = new Set();
    result.rows.forEach(r => {
      JSON.parse(r.tags).forEach(t => tagSet.add(t));
    });
    res.json([...tagSet].sort());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CLAUDE API PROXY
app.post('/api/claude', async (req, res) => {
  if (!CLAUDE_API_KEY) {
    return res.status(400).json({ error: 'Claude API key not configured on server.' });
  }

  try {
    const { prompt, system } = req.body;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: system || 'You are a thoughtful journal assistant. Be warm, insightful, and concise.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || `API error: ${response.status}` });
    }

    const data = await response.json();
    res.json({ text: data.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CLAUDE CHAT (multi-turn)
app.post('/api/claude-chat', async (req, res) => {
  if (!CLAUDE_API_KEY) return res.status(400).json({ error: 'Claude API key not configured on server.' });
  try {
    const { messages, system } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid messages.' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: system || 'You are a thoughtful journal companion.',
        messages
      })
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || `API error: ${response.status}` });
    }
    const data = await response.json();
    res.json({ text: data.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EXPORT
app.get('/api/export', async (req, res) => {
  try {
    const entries = {};
    const entryResult = await db.execute('SELECT * FROM entries');
    entryResult.rows.forEach(r => {
      entries[r.date] = { body: r.body, tags: JSON.parse(r.tags), date: r.date };
    });

    const excerptResult = await db.execute('SELECT * FROM excerpts ORDER BY created_at DESC');
    const excerpts = excerptResult.rows;

    const summaries = {};
    const summaryResult = await db.execute('SELECT * FROM summaries');
    summaryResult.rows.forEach(r => {
      summaries[r.key] = { text: r.text };
    });

    res.json({ entries, excerpts, summaries, exportedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// IMPORT
app.post('/api/import', async (req, res) => {
  try {
    const { entries, excerpts, summaries } = req.body;
    const now = Math.floor(Date.now() / 1000);

    const statements = [];

    if (entries) {
      for (const date of Object.keys(entries)) {
        const e = entries[date];
        statements.push({
          sql: `INSERT INTO entries (date, body, tags, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(date) DO UPDATE SET body = excluded.body, tags = excluded.tags, updated_at = excluded.updated_at`,
          args: [date, e.body || '', JSON.stringify(e.tags || []), now, now]
        });
      }
    }
    if (excerpts) {
      for (const e of excerpts) {
        statements.push({
          sql: 'INSERT INTO excerpts (text, topic, source_date, created_at) VALUES (?, ?, ?, ?)',
          args: [e.text, e.topic || 'Uncategorized', e.source_date || '', now]
        });
      }
    }
    if (summaries) {
      for (const key of Object.keys(summaries)) {
        statements.push({
          sql: `INSERT INTO summaries (key, text, created_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET text = excluded.text`,
          args: [key, summaries[key].text, now]
        });
      }
    }

    if (statements.length > 0) {
      await db.batch(statements, 'write');
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start Server ---
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✨ Reflekt Journal running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
