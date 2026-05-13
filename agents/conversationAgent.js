const Groq = require('groq-sdk')
require('dotenv').config()

const client = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function runConversationAgent(context) {
  const today = new Date().toISOString().split('T')[0]
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0]

  const systemPrompt = `You are the Conversation Understanding agent for ARIA, a voice task manager.
Your only job is to understand what the user wants and extract structured intent.
Do not perform any actions. Do not generate a spoken reply.
Only output valid JSON.

Given the user message and conversation history, extract:
{
  "action": "create" | "read" | "update" | "delete" | "complete" | "clarify" | "chat",
  "confidence": 0.0-1.0,
  "taskReferences": ["exact phrases the user used to refer to tasks"],
  "entities": {
    "titles": ["extracted task titles for creation"],
    "date": "YYYY-MM-DD or null",
    "time": "HH:MM or null",
    "priority": "low|medium|high or null",
    "category": "string or null",
    "timeOfDay": "morning|afternoon|evening|night or null"
  },
  "clarificationNeeded": true|false,
  "clarificationQuestion": "question to ask if unclear or null",
  "rawMessage": "original user message"
}

Date resolution: TODAY=${today}, TOMORROW=${tomorrow}
Time resolution: morning=09:00, afternoon=14:00, evening=18:00, night=21:00
If multiple tasks are mentioned (e.g. "gym at 7, sync at 9, post at 11"), set action="create"
and list all titles in entities.titles with their respective times parsed.

Return ONLY valid JSON. No explanation. No markdown.`

  const historyMessages = (context.history || []).map(h => ({
    role: h.role,
    content: h.content
  }))

  const messages = [
    { role: 'system', content: systemPrompt },
    ...historyMessages,
    { role: 'user', content: context.userMessage }
  ]

  const response = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 1024,
    messages
  })

  const raw = response.choices[0].message.content.trim()
  let intent
  try {
    const cleaned = raw.replace(/^```json\s*/, '').replace(/```$/, '').trim()
    intent = JSON.parse(cleaned)
  } catch {
    intent = {
      action: 'chat',
      confidence: 0.5,
      taskReferences: [],
      entities: { titles: [], date: null, time: null, priority: null, category: null, timeOfDay: null },
      clarificationNeeded: false,
      clarificationQuestion: null,
      rawMessage: context.userMessage
    }
  }

  context.intent = intent
  return context
}

module.exports = { runConversationAgent }
