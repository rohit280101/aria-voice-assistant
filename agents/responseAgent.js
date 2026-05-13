const Groq = require('groq-sdk')
require('dotenv').config()

const client = new Groq({ apiKey: process.env.GROQ_API_KEY })

function formatTasksForSpeech(tasks) {
  if (!tasks || tasks.length === 0) return 'no tasks on the list'
  const today = new Date().toISOString().split('T')[0]
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0]

  const fmt = tasks.slice(0, 8).map(t => {
    let when = ''
    if (t.date === today) when = 'today'
    else if (t.date === tomorrow) when = 'tomorrow'
    else when = `on ${t.date}`

    if (t.time) {
      const [h, m] = t.time.split(':')
      const hr = parseInt(h)
      const ampm = hr >= 12 ? 'PM' : 'AM'
      const hr12 = hr > 12 ? hr - 12 : hr === 0 ? 12 : hr
      when += ` at ${hr12}${m !== '00' ? ':' + m : ''} ${ampm}`
    }
    return `"${t.title}" ${when}`
  })
  return fmt.join(', ')
}

async function runResponseAgent(context, onToken) {
  const { plan, result } = context

  const opsFormatted = (result.operationsCompleted || []).map(op => {
    if (op.type === 'create') return `Created: "${op.task?.title}" on ${op.task?.date}`
    if (op.type === 'update') return `Updated: "${op.task?.title}"`
    if (op.type === 'complete') return `Completed: "${op.task?.title}"`
    if (op.type === 'delete') return op.skipped ? 'Delete pending confirmation' : `Deleted: "${op.task?.title}"`
    if (op.type === 'read') return `Read ${op.tasks?.length || 0} tasks`
    return `No-op: ${op.note || ''}`
  }).join('; ')

  const taskSummary = formatTasksForSpeech(result.updatedTasks)

  const systemPrompt = `You are the Response agent for ARIA, a voice task manager.
Your only job is to generate a natural, conversational spoken response
that the text-to-speech engine will read aloud to the user.

WHAT JUST HAPPENED:
Plan: ${plan.planSummary}
Operations completed: ${opsFormatted}
Current tasks: ${taskSummary}

RULES:
- Write as if speaking out loud — natural rhythm, no bullet points, no markdown
- Keep confirmations short: 1-2 sentences
- For task summaries: group by time of day, mention count and key tasks
- Use friendly contractions: "you've got", "I've added", "let's"
- For deletions that need confirmation: ask clearly and wait
- If nothing matched: say so helpfully and suggest alternatives
- Never say "I have updated the database" or technical language
- Never list more than 4 tasks in a row — summarize instead

Examples:
  Create → "Done! I've added team sync at 10 AM tomorrow to your list."
  Read   → "You've got a busy morning — team sync at 9, then a LinkedIn post at 11."
  Update → "Got it, I've moved the LinkedIn task to 7 PM."
  Delete confirm → "Just to confirm, you want me to delete the evening workout task. Say yes to continue."
  Nothing found → "I couldn't find a task matching that description. Could you be more specific?"

Output ONLY the spoken text. No JSON. No formatting. Just the words to say.`

  let fullText = ''

  const stream = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 512,
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `User said: "${context.userMessage}". Generate spoken response.` }
    ]
  })

  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content || ''
    if (token) {
      fullText += token
      if (onToken) onToken(token)
    }
  }

  context.speech = fullText
  return context
}

module.exports = { runResponseAgent }
