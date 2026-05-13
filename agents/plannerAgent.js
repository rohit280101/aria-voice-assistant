const Groq = require('groq-sdk')
require('dotenv').config()

const client = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function runPlannerAgent(context) {
  const today = new Date().toISOString().split('T')[0]
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0]

  const taskList = (context.tasks || [])
    .map((t, i) =>
      `[${i + 1}] id=${t.id} title="${t.title}" date=${t.date} time=${t.time || 'none'} status=${t.status} priority=${t.priority} category=${t.category || 'none'}`
    )
    .join('\n')

  const systemPrompt = `You are the Planning agent for ARIA, a voice task manager.
Your only job is to create a precise execution plan based on the user's intent.
You have access to the current task list and the extracted intent.
Do not perform any actions. Do not generate a spoken reply.
Only output valid JSON.

TODAY=${today}, TOMORROW=${tomorrow}

CURRENT TASKS:
${taskList || '(no tasks yet)'}

EXTRACTED INTENT:
${JSON.stringify(context.intent, null, 2)}

Output a plan:
{
  "operations": [
    {
      "type": "create" | "update" | "delete" | "complete" | "read" | "none",
      "taskId": "UUID of existing task or null for new tasks",
      "data": {
        "title": "string or null",
        "date": "YYYY-MM-DD or null",
        "time": "HH:MM or null",
        "status": "pending|done or null",
        "priority": "low|medium|high or null",
        "category": "string or null"
      },
      "requiresConfirmation": true|false
    }
  ],
  "readFilter": {
    "date": "YYYY-MM-DD or null",
    "timeOfDay": "morning|afternoon|evening|night or null",
    "status": "pending|done|all"
  },
  "planSummary": "one sentence describing what will happen"
}

Rules:
- For delete operations, ALWAYS set requiresConfirmation=true
- Resolve task references semantically: "the LinkedIn one" matches title containing "LinkedIn"
- "second task" means the task at index 1 in the sorted task list
- "previous task" means the most recently mentioned task in conversation history
- If a reference cannot be resolved, set type="none" and explain in planSummary
- For multiple creates, output one operation object per task
- For read/chat/clarify actions, set operations to [{"type":"read","taskId":null,"data":{},"requiresConfirmation":false}]
- readFilter should be non-null for read operations; use null for write operations
- Default date for new tasks is TODAY (${today}) unless specified

Return ONLY valid JSON. No explanation. No markdown.`

  const response = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(context.intent) }
    ]
  })

  const raw = response.choices[0].message.content.trim()
  let plan
  try {
    const cleaned = raw.replace(/^```json\s*/, '').replace(/```$/, '').trim()
    plan = JSON.parse(cleaned)
  } catch {
    plan = {
      operations: [{ type: 'none', taskId: null, data: {}, requiresConfirmation: false }],
      readFilter: null,
      planSummary: 'Could not parse a valid plan from the intent.'
    }
  }

  context.plan = plan
  return context
}

module.exports = { runPlannerAgent }
