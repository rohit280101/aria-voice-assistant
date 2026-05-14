# ARIA — Voice Task Manager

AI-powered voice task manager with multi-agent architecture,
WebSocket streaming, and PostgreSQL storage.

## Architecture

User voice input flows through a 4-agent pipeline on the backend:

```
[STT] → ConversationAgent → PlannerAgent → ExecutionAgent → ResponseAgent → [TTS]
```

- **ConversationAgent**: extracts intent and entities from natural language
- **PlannerAgent**: resolves task references and plans DB operations
- **ExecutionAgent**: executes operations against PostgreSQL
- **ResponseAgent**: generates natural spoken responses (streamed)

Agent pipeline status is shown live in the header (C → P → E → R).

## Features

### Voice Interaction
- **Hands-free mode** — ARIA auto-restarts listening after each response; toggled via the header button or `H` key; state persisted in localStorage
- **VAD barge-in** — interrupt ARIA mid-speech by speaking; Web Audio API detects voice activity (RMS > 0.015 for 300 ms)
- **Silence detection** — transcript is submitted after 1800 ms of silence
- **Typing fallback** — toggle a text input bar with the `⌨` button for environments without mic access; uses the same dispatch path as voice

### Keyboard Shortcuts
| Key | Action |
|-----|--------|
| `Space` | Toggle listening on/off |
| `Esc` | Interrupt ARIA mid-speech |
| `H` | Toggle hands-free mode |

### Task Management
- Create, read, update, and delete tasks by voice
- Task list with **All / Today / Tomorrow / Done** filters
- Click any task checkbox to toggle its status (persisted to DB immediately)
- Deletion requires voice confirmation ("yes" / "no") to prevent accidents
- Multi-task batch operations with full confirmation for all affected tasks

### Connection Resilience
- WebSocket reconnects automatically with exponential backoff (up to 30 s)
- Countdown shown in the status bar during reconnection
- Client sends up to the last 8 conversation turns with every message so context is never lost on reconnect

## Setup

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- Chrome or Edge browser (required for Web Speech API)

### Installation

1. Install dependencies:
   ```
   npm install
   ```

2. Create a PostgreSQL database:
   ```
   createdb aria_tasks
   ```

3. Initialize the schema:
   ```
   npm run db:init
   ```

4. Copy and fill in environment variables:
   ```
   cp .env.example .env
   ```
   Add your `ANTHROPIC_API_KEY` and `DATABASE_URL`.

5. Start the development server:
   ```
   npm run dev
   ```

6. Open http://localhost:3000 in Chrome or Edge.

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/tasks` | List all tasks |
| `POST` | `/api/tasks` | Create a task |
| `PUT` | `/api/tasks/:id` | Update a task (title, date, time, status, priority, category) |
| `DELETE` | `/api/tasks/:id` | Delete a task |
| `GET` | `/health` | Health check |

## Example Commands

- "Create a task for team sync at 10 AM tomorrow"
- "Create three tasks: gym at 7 AM, standup at 9, lunch with Alex at 1 PM"
- "What are my tasks for this evening?"
- "Move the LinkedIn post to 7 PM"
- "Mark the team sync as done"
- "Delete the gym task"
- "What is on my agenda today?"
- "Change the second task to high priority"
- "Add the standup to the Work category"

## Tech Stack

- **Frontend**: Vanilla HTML, CSS, JavaScript (no framework, no bundler)
- **Backend**: Node.js + Express + WebSocket (ws)
- **AI**: Anthropic Claude claude-sonnet-4-20250514 (multi-agent + streaming)
- **STT**: Web Speech API (browser-native)
- **TTS**: Web Speech Synthesis API (browser-native)
- **VAD**: Web Audio API (RMS-based voice activity detection)
- **Storage**: PostgreSQL via pg

## Browser Support

Chrome and Edge only — required for Web Speech API (SpeechRecognition).

## Get your Anthropic API key

https://console.anthropic.com → API Keys → Create Key

## Deployment (Render.com free tier)

1. Push to GitHub
2. Create a PostgreSQL database on Render (free tier)
3. Create a Web Service, connect your repo
4. Build command: `npm install`
5. Start command: `node server.js`
6. Add environment variables:
   - `ANTHROPIC_API_KEY=your_key`
   - `DATABASE_URL=your_render_postgres_url`
7. Run the schema: connect to Render DB and run `db/schema.sql`
