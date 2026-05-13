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
