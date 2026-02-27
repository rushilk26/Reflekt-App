# Reflekt — Daily Journal

A private, AI-powered daily journaling app with smart summaries, excerpts, and semantic search.

## Features

- **Daily Journaling** — Rich text editor with tags
- **Calendar View** — Browse past entries by date
- **AI Summaries** — Weekly/monthly summaries powered by Claude
- **Excerpts** — Highlight & save text, organized by topic
- **Smart Search** — Full-text + AI semantic search
- **Export/Import** — Full data backup as JSON

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** Turso (hosted libSQL / SQLite-compatible)
- **AI:** Claude API (Anthropic)
- **Frontend:** Vanilla HTML/CSS/JS
- **Hosting:** Render

## Deploy

See deployment guide in the Render dashboard or follow the setup steps in `.env.example`.

## Local Development

```bash
npm install
cp .env.example .env  # Fill in your keys
npm start
# Open http://localhost:3000
```

For local dev without Turso, the app falls back to a local SQLite file automatically.
