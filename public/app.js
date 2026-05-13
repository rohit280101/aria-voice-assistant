// ─── State ────────────────────────────────────────────────────────────────
let tasks = []
let currentFilter = 'all'
let isListening = false
let isSpeaking = false
let isProcessing = false
let recognition = null
let recognitionActive = false
let finalTranscriptBuffer = ''
let silenceTimer = null
let ws = null
let speechQueue = []
let isSpeakingStream = false
let currentUtterance = null
let pendingConfirm = false
let lastHighlightedTaskIds = []

// ─── DOM Refs ─────────────────────────────────────────────────────────────
const voiceBtn       = document.getElementById('voiceBtn')
const voiceLabel     = document.getElementById('voiceLabel')
const voiceOrb       = voiceBtn.closest('.voice-orb-container').parentElement
const transcriptArea = document.getElementById('transcriptArea')
const taskList       = document.getElementById('taskList')
const taskCount      = document.getElementById('taskCount')
const statusDot      = document.getElementById('statusDot')
const statusText     = document.getElementById('statusText')
const confirmOverlay = document.getElementById('confirmOverlay')
const confirmMsg     = document.getElementById('confirmMsg')
const confirmTask    = document.getElementById('confirmTask')
const intrBanner     = document.getElementById('intrBanner')
const toast          = document.getElementById('toast')
const toastMsg       = document.getElementById('toastMsg')
const toastIcon      = document.getElementById('toastIcon')
const noSttBanner    = document.getElementById('noSttBanner')
const voiceCenter    = document.querySelector('.voice-center')

// ─── Agent Pipeline UI ────────────────────────────────────────────────────
const agentSteps = {
  conversation: document.getElementById('agentConversation'),
  planner:      document.getElementById('agentPlanner'),
  execution:    document.getElementById('agentExecution'),
  response:     document.getElementById('agentResponse')
}
const agentOrder = ['conversation', 'planner', 'execution', 'response']

function resetAgentSteps() {
  for (const el of Object.values(agentSteps)) {
    el.classList.remove('active', 'done')
  }
}

function activateAgentStep(name) {
  agentSteps[name]?.classList.add('active')
  agentSteps[name]?.classList.remove('done')
}

function completeAgentStep(name) {
  agentSteps[name]?.classList.remove('active')
  agentSteps[name]?.classList.add('done')
}

function markAllAgentsDone() {
  for (const el of Object.values(agentSteps)) {
    el.classList.remove('active')
    el.classList.add('done')
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────
let wsReconnectDelay = 1000

function initWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${location.host}`
  ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    console.log('Connected to ARIA')
    setOrbState('idle')
  }

  ws.onclose = () => {
    showToast('Connection lost. Reconnecting...', 'warn')
    setTimeout(initWebSocket, 3000)
  }

  ws.onerror = (e) => {
    console.error('WebSocket error:', e)
  }

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    handleServerMessage(message)
  }
}

function sendMessage(type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }))
  }
}

// ─── Server Message Handler ───────────────────────────────────────────────
let speechBuffer = ''
let firstToken = true

function handleServerMessage(msg) {
  switch (msg.type) {

    case 'connected':
      addBubble('ai', "Hi! I'm ARIA. Tap the orb and tell me what you'd like to do.")
      break

    case 'tasks_updated':
      tasks = msg.tasks || []
      renderTasks()
      break

    case 'agent_update':
      if (msg.agent === 'conversation') {
        resetAgentSteps()
        activateAgentStep('conversation')
      } else if (msg.agent === 'planner') {
        completeAgentStep('conversation')
        activateAgentStep('planner')
      } else if (msg.agent === 'execution') {
        completeAgentStep('planner')
        activateAgentStep('execution')
      }
      break

    case 'confirm_required':
      pendingConfirm = true
      confirmTask.textContent = msg.taskTitle || ''
      confirmMsg.textContent = 'Are you sure you want to delete this task?'
      confirmOverlay.classList.add('visible')
      break

    case 'speech_token':
      if (firstToken) {
        firstToken = false
        completeAgentStep('execution')
        activateAgentStep('response')
        isProcessing = false
        setOrbState('speaking')
        isSpeaking = true
        isSpeakingStream = true
      }
      speechBuffer += msg.token
      const shouldSpeak = /[.!?,]/.test(msg.token) || speechBuffer.length > 80
      if (shouldSpeak) {
        enqueueSpeech(speechBuffer)
        speechBuffer = ''
      }
      break

    case 'speech_complete':
      markAllAgentsDone()
      if (speechBuffer) {
        enqueueSpeech(speechBuffer, true)
        speechBuffer = ''
      } else {
        onSpeechQueueDone(msg)
      }
      if (msg.fullText) {
        addBubble('ai', msg.fullText)
      }
      if (msg.affectedTaskIds && msg.affectedTaskIds.length > 0) {
        highlightTasks(msg.affectedTaskIds)
      }
      firstToken = true
      speechBuffer = ''
      pendingSpeechCompleteMsg = msg
      break

    case 'error':
      isProcessing = false
      setOrbState('idle')
      showToast(msg.message || 'An error occurred', 'danger')
      speak('Something went wrong. Please try again.', () => startListening())
      break
  }
}

let pendingSpeechCompleteMsg = null

function onSpeechQueueDone(msg) {
  isSpeaking = false
  isSpeakingStream = false
  setOrbState('idle')
  resetAgentSteps()
  if (!pendingConfirm) {
    setTimeout(() => startListening(), 300)
  }
}

// ─── TTS Speech Queue ─────────────────────────────────────────────────────
function enqueueSpeech(text, isFinal = false) {
  const trimmed = text.trim()
  if (!trimmed) {
    if (isFinal) checkSpeechQueueDone(isFinal)
    return
  }
  speechQueue.push({ text: trimmed, isFinal })
  if (!isSpeakingStream || speechQueue.length === 1) {
    processQueue()
  }
}

function checkSpeechQueueDone(isFinal) {
  if (isFinal && speechQueue.length === 0 && !currentUtterance) {
    if (pendingSpeechCompleteMsg) {
      onSpeechQueueDone(pendingSpeechCompleteMsg)
      pendingSpeechCompleteMsg = null
    }
  }
}

function processQueue() {
  if (speechQueue.length === 0) {
    if (pendingSpeechCompleteMsg) {
      onSpeechQueueDone(pendingSpeechCompleteMsg)
      pendingSpeechCompleteMsg = null
    }
    return
  }
  const item = speechQueue.shift()
  speakChunk(item.text, () => {
    processQueue()
  })
}

function speakChunk(text, onEnd) {
  if (!window.speechSynthesis) { onEnd && onEnd(); return }
  stopSpeaking()
  const utt = new SpeechSynthesisUtterance(text)
  utt.rate = 1.0
  utt.pitch = 1.0
  utt.volume = 1.0
  utt.onend = () => {
    currentUtterance = null
    onEnd && onEnd()
  }
  utt.onerror = () => {
    currentUtterance = null
    onEnd && onEnd()
  }
  currentUtterance = utt
  window.speechSynthesis.speak(utt)
}

function speak(text, onEnd) {
  if (!window.speechSynthesis) { onEnd && onEnd(); return }
  stopSpeaking()
  clearSpeechQueue()
  isSpeaking = true
  setOrbState('speaking')
  const utt = new SpeechSynthesisUtterance(text)
  utt.rate = 1.0
  utt.pitch = 1.0
  utt.volume = 1.0
  utt.onend = () => {
    currentUtterance = null
    isSpeaking = false
    setOrbState('idle')
    onEnd && onEnd()
  }
  utt.onerror = () => {
    currentUtterance = null
    isSpeaking = false
    setOrbState('idle')
    onEnd && onEnd()
  }
  currentUtterance = utt
  window.speechSynthesis.speak(utt)
}

function stopSpeaking() {
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel()
  }
  currentUtterance = null
}

function clearSpeechQueue() {
  speechQueue = []
}

// ─── STT Recognition ──────────────────────────────────────────────────────
function initRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SpeechRecognition) {
    noSttBanner.style.display = 'block'
    return
  }

  recognition = new SpeechRecognition()
  recognition.continuous = true
  recognition.interimResults = true
  recognition.lang = 'en-US'

  recognition.onstart = () => {
    recognitionActive = true
    isListening = true
    setOrbState('listening')
    setVoiceLabel('listening...')
    finalTranscriptBuffer = ''
  }

  recognition.onresult = (event) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      if (result.isFinal) {
        finalTranscriptBuffer += result[0].transcript + ' '
        clearTimeout(silenceTimer)
        silenceTimer = setTimeout(submitFinalTranscript, 1200)
      } else {
        interim += result[0].transcript
      }
    }
    updateInterimBubble(interim || finalTranscriptBuffer)
  }

  recognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return
    console.error('STT error:', event.error)
    if (event.error === 'not-allowed') {
      showToast('Microphone access denied.', 'danger')
      noSttBanner.style.display = 'block'
    }
    recognitionActive = false
    isListening = false
    setOrbState('idle')
    setVoiceLabel('tap to speak')
  }

  recognition.onend = () => {
    recognitionActive = false
    if (isListening && !isProcessing) {
      try { recognition.start() } catch {}
    } else {
      isListening = false
      if (!isProcessing && !isSpeaking) {
        setOrbState('idle')
        setVoiceLabel('tap to speak')
      }
    }
  }
}

function submitFinalTranscript() {
  const text = finalTranscriptBuffer.trim()
  if (!text) return
  finalTranscriptBuffer = ''
  clearInterimBubble()
  addBubble('user', text)
  isListening = false
  isProcessing = true
  stopListening()
  setOrbState('processing')
  setVoiceLabel('processing...')
  resetAgentSteps()
  sendMessage('user_message', { text })
}

function startListening() {
  if (!recognition || isProcessing || isSpeaking) return
  if (recognitionActive) return
  isListening = true
  finalTranscriptBuffer = ''
  try { recognition.start() } catch {}
}

function stopListening() {
  isListening = false
  if (recognitionActive) {
    try { recognition.stop() } catch {}
  }
}

// ─── Toggle / Interruption ────────────────────────────────────────────────
function toggleListening() {
  if (isSpeaking || isSpeakingStream) {
    stopSpeaking()
    clearSpeechQueue()
    isSpeaking = false
    isSpeakingStream = false
    isProcessing = false
    showInterruption()
    setOrbState('idle')
    setTimeout(() => startListening(), 200)
    return
  }
  if (isProcessing) return
  if (isListening) {
    stopListening()
    setOrbState('idle')
    setVoiceLabel('tap to speak')
  } else {
    startListening()
  }
}

let intrTimer = null
function showInterruption() {
  intrBanner.classList.add('visible')
  clearTimeout(intrTimer)
  intrTimer = setTimeout(() => intrBanner.classList.remove('visible'), 2000)
}

// ─── Orb State ────────────────────────────────────────────────────────────
function setOrbState(state) {
  voiceCenter.classList.remove('orb-idle', 'orb-listening', 'orb-processing', 'orb-speaking')
  voiceCenter.classList.add(`orb-${state}`)
  if (state === 'listening') setVoiceLabel('listening...')
  else if (state === 'processing') setVoiceLabel('processing...')
  else if (state === 'speaking') setVoiceLabel('speaking...')
  else setVoiceLabel('tap to speak')

  if (state === 'processing') {
    statusDot.className = 'status-dot processing'
    statusText.textContent = 'processing'
  } else if (state === 'speaking') {
    statusDot.className = 'status-dot speaking'
    statusText.textContent = 'speaking'
  } else if (state === 'listening') {
    statusDot.className = 'status-dot active'
    statusText.textContent = 'listening'
  } else {
    setStatus('active')
  }
}

function setVoiceLabel(text) {
  voiceLabel.textContent = text
}

function setStatus(state) {
  if (state === 'active') {
    statusDot.className = 'status-dot active'
    statusText.textContent = 'connected'
  } else if (state === 'disconnected') {
    statusDot.className = 'status-dot'
    statusText.textContent = 'disconnected'
  }
}

// ─── Transcript Bubbles ───────────────────────────────────────────────────
let interimBubble = null

function addBubble(type, text) {
  clearInterimBubble()
  const div = document.createElement('div')
  div.className = `bubble ${type}`
  div.textContent = text
  transcriptArea.appendChild(div)
  transcriptArea.scrollTop = transcriptArea.scrollHeight
}

function updateInterimBubble(text) {
  if (!interimBubble) {
    interimBubble = document.createElement('div')
    interimBubble.className = 'bubble interim'
    transcriptArea.appendChild(interimBubble)
  }
  interimBubble.textContent = text
  transcriptArea.scrollTop = transcriptArea.scrollHeight
}

function clearInterimBubble() {
  if (interimBubble) {
    interimBubble.remove()
    interimBubble = null
  }
}

// ─── Task Rendering ───────────────────────────────────────────────────────
function renderTasks() {
  const today = new Date().toISOString().split('T')[0]
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0]

  let filtered = [...tasks]
  if (currentFilter === 'today') filtered = tasks.filter(t => t.date === today)
  else if (currentFilter === 'tomorrow') filtered = tasks.filter(t => t.date === tomorrow)
  else if (currentFilter === 'done') filtered = tasks.filter(t => t.status === 'done')
  else filtered = tasks

  taskCount.textContent = filtered.length

  if (filtered.length === 0) {
    taskList.innerHTML = `
      <div class="task-empty">
        <span class="empty-icon">○</span>
        <span>No tasks here yet</span>
        <span>Say "create a task" to add one</span>
      </div>`
    return
  }

  taskList.innerHTML = ''
  for (const task of filtered) {
    const el = document.createElement('div')
    el.className = `task-item priority-${task.priority || 'medium'}${task.status === 'done' ? ' done-task' : ''}`
    el.dataset.id = task.id
    if (lastHighlightedTaskIds.includes(task.id)) {
      el.classList.add('highlighted')
    }

    let dateLabel = ''
    if (task.date === today) dateLabel = 'Today'
    else if (task.date === tomorrow) dateLabel = 'Tomorrow'
    else {
      const d = new Date(task.date + 'T00:00:00')
      dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }

    let timeLabel = ''
    if (task.time) {
      const [h, m] = task.time.split(':')
      const hr = parseInt(h)
      const ampm = hr >= 12 ? 'PM' : 'AM'
      const hr12 = hr > 12 ? hr - 12 : hr === 0 ? 12 : hr
      timeLabel = ` · ${hr12}${m !== '00' ? ':' + m : ''} ${ampm}`
    }

    const badgeClass = `badge-${task.priority || 'medium'}`
    const priorityLabel = task.priority || 'medium'

    el.innerHTML = `
      <div class="task-item-top">
        <div class="task-checkbox"></div>
        <div class="task-body">
          <div class="task-title">${escHtml(task.title)}</div>
          <div class="task-meta">
            <span class="task-date">${dateLabel}${timeLabel}</span>
            <span class="task-priority-badge ${badgeClass}">${priorityLabel}</span>
            ${task.category ? `<span class="task-item-category">${escHtml(task.category)}</span>` : ''}
          </div>
        </div>
      </div>`

    taskList.appendChild(el)
  }
}

function highlightTasks(ids) {
  lastHighlightedTaskIds = ids
  renderTasks()
  setTimeout(() => {
    const firstEl = taskList.querySelector('.highlighted')
    if (firstEl) firstEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, 100)
  setTimeout(() => {
    lastHighlightedTaskIds = []
    document.querySelectorAll('.task-item.highlighted').forEach(el => el.classList.remove('highlighted'))
  }, 3500)
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Filters ──────────────────────────────────────────────────────────────
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    currentFilter = btn.dataset.filter
    renderTasks()
  })
})

// ─── Hint Chips ───────────────────────────────────────────────────────────
document.querySelectorAll('.hint-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    if (isProcessing || isSpeaking) return
    const text = btn.dataset.hint
    if (!text) return
    stopListening()
    addBubble('user', text)
    isProcessing = true
    setOrbState('processing')
    resetAgentSteps()
    sendMessage('user_message', { text })
  })
})

// ─── Voice Button ─────────────────────────────────────────────────────────
voiceBtn.addEventListener('click', toggleListening)

// ─── Toast ────────────────────────────────────────────────────────────────
let toastTimer = null
function showToast(msg, type = 'info') {
  toast.textContent = ''
  const icons = { danger: '✕', success: '✓', warn: '⚠', info: 'ℹ' }
  const iconEl = document.createElement('span')
  iconEl.className = 'toast-icon'
  iconEl.textContent = icons[type] || 'ℹ'
  const msgEl = document.createElement('span')
  msgEl.textContent = msg
  toast.appendChild(iconEl)
  toast.appendChild(msgEl)
  toast.className = `toast toast-${type} show`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500)
}

// ─── Ping keepalive ───────────────────────────────────────────────────────
setInterval(() => sendMessage('ping'), 20000)

// ─── Init ─────────────────────────────────────────────────────────────────
initRecognition()
initWebSocket()
setOrbState('idle')
