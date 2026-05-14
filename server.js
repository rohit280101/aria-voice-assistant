require('dotenv').config()
const express = require('express')
const http = require('http')
const WebSocket = require('ws')
const path = require('path')
const cors = require('cors')
const db = require('./db/index')
const { runConversationAgent } = require('./agents/conversationAgent')
const { runPlannerAgent } = require('./agents/plannerAgent')
const { runExecutionAgent } = require('./agents/executionAgent')
const { runResponseAgent } = require('./agents/responseAgent')

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ─── HTTP Routes ────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.get('/api/tasks', async (_req, res) => {
  try {
    const result = await db.query('SELECT * FROM tasks ORDER BY date ASC, time ASC NULLS LAST')
    res.json(result.rows)
  } catch (err) {
    console.error('GET /api/tasks:', err)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/tasks', async (req, res) => {
  try {
    const { title, date, time, priority, category } = req.body
    const today = new Date().toISOString().split('T')[0]
    const result = await db.query(
      `INSERT INTO tasks (title, date, time, priority, category)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [title, date || today, time || null, priority || 'medium', category || null]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error('POST /api/tasks:', err)
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params
    const fields = req.body
    const setClauses = []
    const values = [id]
    let idx = 2
    const allowed = ['title', 'date', 'time', 'status', 'priority', 'category']
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        setClauses.push(`${key} = $${idx++}`)
        values.push(fields[key])
      }
    }
    if (setClauses.length === 0) return res.status(400).json({ error: 'No valid fields to update' })
    const result = await db.query(
      `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      values
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' })
    res.json(result.rows[0])
  } catch (err) {
    console.error('PUT /api/tasks/:id:', err)
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params
    await db.query('DELETE FROM tasks WHERE id = $1', [id])
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /api/tasks/:id:', err)
    res.status(500).json({ error: err.message })
  }
})

// ─── WebSocket Server ───────────────────────────────────────────────────────

const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj))
  }
}

wss.on('connection', async (ws) => {
  const state = {
    conversationHistory: [],
    pendingConfirmation: null
  }

  send(ws, { type: 'connected', message: 'ARIA is ready' })

  try {
    const result = await db.query('SELECT * FROM tasks ORDER BY date ASC, time ASC NULLS LAST')
    send(ws, { type: 'tasks_updated', tasks: result.rows })
  } catch (err) {
    console.error('Error loading initial tasks:', err)
  }

  ws.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (msg.type === 'ping') {
      send(ws, { type: 'pong' })
      return
    }

    if (msg.type !== 'user_message') return

    const userText = (msg.text || '').trim()
    if (!userText) return

    const clientHistory = Array.isArray(msg.history) ? msg.history : null
    const effectiveHistory = (clientHistory && clientHistory.length)
      ? clientHistory
      : state.conversationHistory

    try {
      // ── Handle pending delete confirmation ──────────────────────────────
      if (state.pendingConfirmation) {
        const lower = userText.toLowerCase()
        const isYes = /\b(yes|yeah|yep|confirm|do it|go ahead|sure|ok|okay)\b/.test(lower)
        const isNo = /\b(no|nope|cancel|stop|nevermind|never mind|don't|dont)\b/.test(lower)

        if (isYes) {
          const op = state.pendingConfirmation
          op.confirmed = true
          state.pendingConfirmation = null

          const ctx = {
            userMessage: userText,
            history: effectiveHistory,
            tasks: [],
            intent: null,
            plan: { operations: [op], readFilter: null, planSummary: `Delete confirmed by user` },
            result: null,
            speech: ''
          }

          const afterExec = await runExecutionAgent(ctx)
          send(ws, { type: 'tasks_updated', tasks: afterExec.result.updatedTasks })

          let speechBuffer = ''
          const afterResp = await runResponseAgent(afterExec, (token) => {
            send(ws, { type: 'speech_token', token })
            speechBuffer += token
          })

          send(ws, {
            type: 'speech_complete',
            fullText: afterResp.speech,
            affectedTaskIds: afterExec.result.affectedTaskIds
          })

          state.conversationHistory.push(
            { role: 'user', content: userText },
            { role: 'assistant', content: afterResp.speech }
          )
          if (state.conversationHistory.length > 20) {
            state.conversationHistory = state.conversationHistory.slice(-20)
          }
        } else if (isNo) {
          state.pendingConfirmation = null
          const cancelText = "Okay, I've cancelled that. Anything else?"
          send(ws, { type: 'speech_token', token: cancelText })
          send(ws, { type: 'speech_complete', fullText: cancelText, affectedTaskIds: [] })
          state.conversationHistory.push(
            { role: 'user', content: userText },
            { role: 'assistant', content: cancelText }
          )
        } else {
          const clarifyText = "Just say yes to confirm the deletion, or no to cancel."
          send(ws, { type: 'speech_token', token: clarifyText })
          send(ws, { type: 'speech_complete', fullText: clarifyText, affectedTaskIds: [] })
        }
        return
      }

      // ── Full agent pipeline ──────────────────────────────────────────────
      const tasksResult = await db.query('SELECT * FROM tasks ORDER BY date ASC, time ASC NULLS LAST')
      const context = {
        userMessage: userText,
        history: effectiveHistory,
        tasks: tasksResult.rows,
        intent: null,
        plan: null,
        result: null,
        speech: ''
      }

      // Agent 1: Conversation
      const afterConv = await runConversationAgent(context)
      send(ws, { type: 'agent_update', agent: 'conversation', data: afterConv.intent })

      // Agent 2: Planner
      const afterPlan = await runPlannerAgent(afterConv)
      send(ws, { type: 'agent_update', agent: 'planner', data: afterPlan.plan })

      // Check if any op needs confirmation
      const confirmOp = afterPlan.plan.operations.find(op => op.requiresConfirmation)
      if (confirmOp) {
        state.pendingConfirmation = confirmOp

        // Find the task name for UX display
        let taskTitle = 'this task'
        if (confirmOp.taskId) {
          const found = tasksResult.rows.find(t => t.id === confirmOp.taskId)
          if (found) taskTitle = found.title
        }

        const confirmCtx = {
          ...afterPlan,
          result: {
            operationsCompleted: [{ type: 'delete', skipped: true, reason: 'awaiting confirmation' }],
            updatedTasks: tasksResult.rows,
            affectedTaskIds: []
          }
        }

        send(ws, {
          type: 'confirm_required',
          taskTitle,
          message: `Just to confirm — you want me to delete "${taskTitle}". Say yes to continue.`
        })

        let fullText = ''
        const afterResp = await runResponseAgent(confirmCtx, (token) => {
          send(ws, { type: 'speech_token', token })
          fullText += token
        })
        send(ws, { type: 'speech_complete', fullText: afterResp.speech, affectedTaskIds: [] })
        return
      }

      // Agent 3: Execution
      const afterExec = await runExecutionAgent(afterPlan)
      send(ws, { type: 'agent_update', agent: 'execution', data: {
        operationsCompleted: afterExec.result.operationsCompleted,
        affectedTaskIds: afterExec.result.affectedTaskIds
      }})
      send(ws, { type: 'tasks_updated', tasks: afterExec.result.updatedTasks })

      // Agent 4: Response (streaming)
      const afterResp = await runResponseAgent(afterExec, (token) => {
        send(ws, { type: 'speech_token', token })
      })

      send(ws, {
        type: 'speech_complete',
        fullText: afterResp.speech,
        affectedTaskIds: afterExec.result.affectedTaskIds
      })

      state.conversationHistory.push(
        { role: 'user', content: userText },
        { role: 'assistant', content: afterResp.speech }
      )
      if (state.conversationHistory.length > 20) {
        state.conversationHistory = state.conversationHistory.slice(-20)
      }

    } catch (err) {
      console.error('Pipeline error:', err)
      send(ws, { type: 'error', message: 'Something went wrong processing your request.' })
    }
  })

  ws.on('error', (err) => console.error('WebSocket error:', err))
  ws.on('close', () => console.log('WebSocket client disconnected'))
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`ARIA server running at http://localhost:${PORT}`)
})
