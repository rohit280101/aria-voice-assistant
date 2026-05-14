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
let suppressAutoRestart = false

const SILENCE_TIMER_MS = 1800
const SEND_TRIGGER_RE = /\b(send|submit)\b\s*[.,!?]*\s*$/i

// ─── Hands-Free Mode ──────────────────────────────────────────────────────
let handsFreeMode = localStorage.getItem('aria-handsfree') === 'true'

// ─── Conversation History (client-side authoritative) ────────────────────
const MAX_HISTORY_MESSAGES = 16 // 8 turns × 2 messages
let conversationHistory = []
let lastUserText = ''

function pushHistory(role, content) {
  conversationHistory.push({ role, content })
  while (conversationHistory.length > MAX_HISTORY_MESSAGES) {
    conversationHistory.shift()
  }
}

// ─── DOM Refs ─────────────────────────────────────────────────────────────
const voiceBtn        = document.getElementById('voiceBtn')
const voiceLabel      = document.getElementById('voiceLabel')
const voiceOrb        = voiceBtn.closest('.voice-orb-container').parentElement
const transcriptArea  = document.getElementById('transcriptArea')
const taskList        = document.getElementById('taskList')
const taskCount       = document.getElementById('taskCount')
const statusDot       = document.getElementById('statusDot')
const statusText      = document.getElementById('statusText')
const confirmOverlay  = document.getElementById('confirmOverlay')
const confirmMsg      = document.getElementById('confirmMsg')
const confirmTask     = document.getElementById('confirmTask')
const intrBanner      = document.getElementById('intrBanner')
const toast           = document.getElementById('toast')
const toastMsg        = document.getElementById('toastMsg')
const toastIcon       = document.getElementById('toastIcon')
const noSttBanner     = document.getElementById('noSttBanner')
const voiceCenter     = document.querySelector('.voice-center')
const handsfreeBtn    = document.getElementById('handsfreeBtn')
const typingBar       = document.getElementById('typingBar')
const typingInput     = document.getElementById('typingInput')
const typingSendBtn   = document.getElementById('typingSendBtn')
const typingToggleBtn = document.getElementById('typingToggleBtn')

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

// ─── WebSocket (with exponential backoff) ─────────────────────────────────
let wsReconnectDelay = 1000
let wsReconnectTimer = null
let wsCountdownInterval = null

function clearWsReconnect() {
  if (wsCountdownInterval) {
    clearInterval(wsCountdownInterval)
    wsCountdownInterval = null
  }
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer)
    wsReconnectTimer = null
  }
}

function initWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${location.host}`
  ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    console.log('Connected to ARIA')
    wsReconnectDelay = 1000
    clearWsReconnect()
    setOrbState('idle')
  }

  ws.onclose = () => {
    clearWsReconnect()
    setStatus('disconnected')
    scheduleReconnect()
  }

  ws.onerror = (e) => {
    console.error('WebSocket error:', e)
  }

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    handleServerMessage(message)
  }
}

function scheduleReconnect() {
  let secondsLeft = Math.max(1, Math.round(wsReconnectDelay / 1000))
  statusDot.className = 'status-dot'
  statusText.textContent = `reconnecting in ${secondsLeft}s...`

  clearWsReconnect()
  wsCountdownInterval = setInterval(() => {
    secondsLeft--
    if (secondsLeft <= 0) {
      clearInterval(wsCountdownInterval)
      wsCountdownInterval = null
      statusText.textContent = 'reconnecting...'
      return
    }
    statusText.textContent = `reconnecting in ${secondsLeft}s...`
  }, 1000)

  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null
    if (wsCountdownInterval) {
      clearInterval(wsCountdownInterval)
      wsCountdownInterval = null
    }
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000)
    initWebSocket()
  }, wsReconnectDelay)
}

function sendMessage(type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }))
  }
}

// ─── Server Message Handler ───────────────────────────────────────────────
let speechBuffer = ''
let firstToken = true
let pendingSpeechCompleteMsg = null

function handleServerMessage(msg) {
  switch (msg.type) {

    case 'connected':
      addBubble('ai', "Hi! I'm ARIA. Tap the orb and tell me what you'd like to do.")
      if (handsFreeMode) maybeResumeListening(400)
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
        startVAD()
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
      firstToken = true
      pendingSpeechCompleteMsg = msg   // set before enqueueSpeech so processQueue can use it
      if (speechBuffer) {
        enqueueSpeech(speechBuffer, true)
        speechBuffer = ''
      } else if (speechQueue.length === 0 && !currentUtterance) {
        // Queue already drained — fire immediately
        onSpeechQueueDone(msg)
        pendingSpeechCompleteMsg = null
      }
      // else: queue still draining; processQueue will call onSpeechQueueDone when empty
      if (msg.fullText) {
        addBubble('ai', msg.fullText)
        if (lastUserText) {
          pushHistory('user', lastUserText)
          pushHistory('assistant', msg.fullText)
          lastUserText = ''
        }
      }
      if (msg.affectedTaskIds && msg.affectedTaskIds.length > 0) {
        highlightTasks(msg.affectedTaskIds)
      }
      break

    case 'error':
      isProcessing = false
      setOrbState('idle')
      showToast(msg.message || 'An error occurred', 'danger')
      speak('Something went wrong. Please try again.', () => {
        if (!maybeResumeListening(150)) startListening()
      })
      break
  }
}

function onSpeechQueueDone(msg) {
  isSpeaking = false
  isSpeakingStream = false
  stopVAD()
  setOrbState('idle')
  resetAgentSteps()
  if (handsFreeMode) {
    setVoiceLabel('listening...')
    setTimeout(() => {
      if (!isListening && !isProcessing && !isSpeaking && !isSpeakingStream) {
        startListening()
      }
    }, 300)
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
  startVAD()
  const utt = new SpeechSynthesisUtterance(text)
  utt.rate = 1.0
  utt.pitch = 1.0
  utt.volume = 1.0
  utt.onend = () => {
    currentUtterance = null
    isSpeaking = false
    stopVAD()
    setOrbState('idle')
    onEnd && onEnd()
  }
  utt.onerror = () => {
    currentUtterance = null
    isSpeaking = false
    stopVAD()
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

// ─── Voice Activity Detection (Barge-In) ──────────────────────────────────
let vadStream = null
let vadAudioContext = null
let vadAnalyser = null
let vadRafId = null
let vadAboveThresholdSince = 0
let vadStarting = false
const VAD_RMS_THRESHOLD = 0.015
const VAD_TRIGGER_MS = 300

async function startVAD() {
  if (vadAudioContext || vadStarting) return
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return
  vadStarting = true
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    // If speaking ended while we were waiting on permission, abort.
    if (!isSpeaking && !isSpeakingStream) {
      stream.getTracks().forEach(t => t.stop())
      return
    }
    vadStream = stream
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    vadAudioContext = new AudioCtx()
    const source = vadAudioContext.createMediaStreamSource(vadStream)
    vadAnalyser = vadAudioContext.createAnalyser()
    vadAnalyser.fftSize = 512
    source.connect(vadAnalyser)

    const buffer = new Float32Array(vadAnalyser.fftSize)
    vadAboveThresholdSince = 0

    const tick = () => {
      if (!vadAnalyser) return
      vadAnalyser.getFloatTimeDomainData(buffer)
      let sum = 0
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
      const rms = Math.sqrt(sum / buffer.length)

      const now = performance.now()
      if (rms > VAD_RMS_THRESHOLD) {
        if (vadAboveThresholdSince === 0) vadAboveThresholdSince = now
        if (now - vadAboveThresholdSince > VAD_TRIGGER_MS) {
          handleBargeIn()
          return
        }
      } else {
        vadAboveThresholdSince = 0
      }
      vadRafId = requestAnimationFrame(tick)
    }
    vadRafId = requestAnimationFrame(tick)
  } catch (e) {
    console.warn('VAD start failed:', e && e.message)
  } finally {
    vadStarting = false
  }
}

function stopVAD() {
  if (vadRafId) { cancelAnimationFrame(vadRafId); vadRafId = null }
  if (vadAnalyser) { try { vadAnalyser.disconnect() } catch {} ; vadAnalyser = null }
  if (vadAudioContext) {
    try { vadAudioContext.close() } catch {}
    vadAudioContext = null
  }
  if (vadStream) {
    vadStream.getTracks().forEach(t => { try { t.stop() } catch {} })
    vadStream = null
  }
  vadAboveThresholdSince = 0
}

function handleBargeIn() {
  if (!isSpeaking && !isSpeakingStream) { stopVAD(); return }
  stopVAD()
  stopSpeaking()
  clearSpeechQueue()
  isSpeaking = false
  isSpeakingStream = false
  pendingSpeechCompleteMsg = null
  showInterruption()
  setOrbState('idle')
  resetAgentSteps()
  setTimeout(() => startListening(), 150)
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
    suppressAutoRestart = false
    setOrbState('listening')
    setVoiceLabel('listening...')
    finalTranscriptBuffer = ''
  }

  recognition.onresult = (event) => {
    let interim = ''
    let lastFinalChunk = ''

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      if (result.isFinal) {
        const chunk = result[0].transcript
        finalTranscriptBuffer += chunk + ' '
        lastFinalChunk = chunk
        clearTimeout(silenceTimer)
        silenceTimer = setTimeout(submitFinalTranscript, SILENCE_TIMER_MS)
      } else {
        interim += result[0].transcript
      }
    }

    // "send" / "submit" voice command — fire immediately, skip silence wait.
    let triggeredSend = false
    if (lastFinalChunk && SEND_TRIGGER_RE.test(lastFinalChunk.trim())) {
      finalTranscriptBuffer = finalTranscriptBuffer.replace(SEND_TRIGGER_RE, '').trim() + ' '
      clearTimeout(silenceTimer)
      triggeredSend = true
    }

    // Voice label: "got it..." after finalization; revert to "listening..."
    // when only fresh interim arrives (user resumed speaking after a pause).
    if (lastFinalChunk) {
      setVoiceLabel('got it...')
    } else if (interim) {
      setVoiceLabel('listening...')
    }

    updateInterimBubble(interim || finalTranscriptBuffer)

    if (triggeredSend) submitFinalTranscript()
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
    setVoiceLabel(handsFreeMode ? 'tap to resume' : 'tap to speak')
  }

  recognition.onend = () => {
    recognitionActive = false
    if (isListening && !isProcessing) {
      try { recognition.start() } catch {}
      return
    }
    if (
      handsFreeMode &&
      !suppressAutoRestart &&
      !isProcessing &&
      !isSpeaking &&
      !isSpeakingStream
    ) {
      setTimeout(() => {
        if (
          handsFreeMode &&
          !suppressAutoRestart &&
          !isListening &&
          !isProcessing &&
          !isSpeaking &&
          !isSpeakingStream
        ) {
          startListening()
        }
      }, 200)
      return
    }
    isListening = false
    if (!isProcessing && !isSpeaking) {
      setOrbState('idle')
      setVoiceLabel(handsFreeMode ? 'tap to resume' : 'tap to speak')
    }
  }
}

function submitFinalTranscript() {
  const text = finalTranscriptBuffer.trim()
  finalTranscriptBuffer = ''
  if (!text) {
    isListening = false
    setOrbState('idle')
    maybeResumeListening(300)
    return
  }
  if (text.split(/\s+/).length < 2) {
    isListening = false
    setOrbState('idle')
    maybeResumeListening(300)
    return
  }
  if (isSpeaking || isSpeakingStream) {
    isListening = false
    setOrbState('idle')
    return
  }
  dispatchUserText(text)
}

function dispatchUserText(text) {
  const trimmed = (text || '').trim()
  if (!trimmed) return
  if (isProcessing) return
  clearInterimBubble()
  addBubble('user', trimmed)
  isListening = false
  isProcessing = true
  stopListening()
  setOrbState('processing')
  setVoiceLabel('processing...')
  resetAgentSteps()
  lastUserText = trimmed
  sendMessage('user_message', { text: trimmed, history: conversationHistory.slice() })
}

function startListening() {
  if (!recognition || isProcessing || isSpeaking || isSpeakingStream) return
  if (recognitionActive) return
  suppressAutoRestart = false
  isListening = true
  finalTranscriptBuffer = ''
  try { recognition.start() } catch {}
}

function stopListening() {
  isListening = false
  suppressAutoRestart = true
  if (recognitionActive) {
    try { recognition.stop() } catch {}
  }
}

function maybeResumeListening(delay = 300) {
  if (!handsFreeMode) return false
  if (isProcessing || isSpeaking || isSpeakingStream) return false
  setTimeout(() => {
    if (
      handsFreeMode &&
      !isListening &&
      !isProcessing &&
      !isSpeaking &&
      !isSpeakingStream
    ) {
      startListening()
    }
  }, delay)
  return true
}

// ─── Toggle / Interruption ────────────────────────────────────────────────
function toggleListening() {
  if (isSpeaking || isSpeakingStream) {
    stopVAD()
    stopSpeaking()
    clearSpeechQueue()
    isSpeaking = false
    isSpeakingStream = false
    isProcessing = false
    pendingSpeechCompleteMsg = null
    showInterruption()
    setOrbState('idle')
    resetAgentSteps()
    setTimeout(() => startListening(), 200)
    return
  }
  if (isProcessing) return
  if (isListening) {
    stopListening()
    setOrbState('idle')
    setVoiceLabel(handsFreeMode ? 'tap to resume' : 'tap to speak')
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
  else setVoiceLabel(handsFreeMode ? 'tap to resume' : 'tap to speak')

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
    if (!task.date) dateLabel = ''
    else if (task.date === today) dateLabel = 'Today'
    else if (task.date === tomorrow) dateLabel = 'Tomorrow'
    else {
      const d = new Date(task.date + 'T00:00:00')
      dateLabel = isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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

taskList.addEventListener('click', async (e) => {
  const checkbox = e.target.closest('.task-checkbox')
  if (!checkbox) return
  const el = checkbox.closest('.task-item')
  if (!el) return
  const id = parseInt(el.dataset.id)
  const task = tasks.find(t => t.id === id)
  if (!task) return
  const newStatus = task.status === 'done' ? 'active' : 'done'
  task.status = newStatus
  renderTasks()
  try {
    await fetch(`/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    })
  } catch (err) {
    task.status = newStatus === 'done' ? 'active' : 'done'
    renderTasks()
  }
})

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

// ─── Hands-Free UI ────────────────────────────────────────────────────────
function applyHandsFreeUI() {
  handsfreeBtn.classList.toggle('active', handsFreeMode)
  handsfreeBtn.setAttribute('aria-pressed', handsFreeMode ? 'true' : 'false')
}

function toggleHandsFree() {
  handsFreeMode = !handsFreeMode
  localStorage.setItem('aria-handsfree', handsFreeMode ? 'true' : 'false')
  applyHandsFreeUI()
  showToast(handsFreeMode ? 'Hands-free mode on' : 'Hands-free mode off', handsFreeMode ? 'success' : 'info')
  if (handsFreeMode) {
    maybeResumeListening(200)
  }
  if (!isListening && !isProcessing && !isSpeaking && !isSpeakingStream) {
    setVoiceLabel(handsFreeMode ? 'listening...' : 'tap to speak')
  }
}

handsfreeBtn.addEventListener('click', toggleHandsFree)
applyHandsFreeUI()

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
document.querySelectorAll('.hint-chip[data-hint]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (isProcessing || isSpeaking || isSpeakingStream) return
    const text = btn.dataset.hint
    if (!text) return
    dispatchUserText(text)
  })
})

// ─── Typing Fallback Input ────────────────────────────────────────────────
function submitTyped() {
  const text = typingInput.value.trim()
  if (!text) return
  typingInput.value = ''
  if (isSpeaking || isSpeakingStream) {
    // Interrupt current speech if user typed during it
    stopVAD()
    stopSpeaking()
    clearSpeechQueue()
    isSpeaking = false
    isSpeakingStream = false
    pendingSpeechCompleteMsg = null
    resetAgentSteps()
  }
  dispatchUserText(text)
}

typingSendBtn.addEventListener('click', submitTyped)
typingInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    submitTyped()
  }
})

typingToggleBtn.addEventListener('click', () => {
  const isHidden = typingBar.hasAttribute('hidden')
  if (isHidden) {
    typingBar.removeAttribute('hidden')
    typingToggleBtn.classList.add('active')
    setTimeout(() => typingInput.focus(), 0)
  } else {
    typingBar.setAttribute('hidden', '')
    typingToggleBtn.classList.remove('active')
    typingInput.blur()
  }
})

// ─── Voice Button ─────────────────────────────────────────────────────────
voiceBtn.addEventListener('click', toggleListening)

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const focused = document.activeElement
  const focusedTag = focused?.tagName
  const isTyping = focusedTag === 'INPUT' || focusedTag === 'TEXTAREA'
  const isButton = focusedTag === 'BUTTON'
  const hasMod = e.metaKey || e.ctrlKey || e.altKey

  if (e.code === 'Space' && !isTyping && !isButton && !hasMod && !e.repeat) {
    e.preventDefault()
    toggleListening()
    return
  }

  if (e.key === 'Escape') {
    if (isSpeaking || isSpeakingStream || isProcessing) {
      stopVAD()
      stopSpeaking()
      clearSpeechQueue()
      isSpeaking = false
      isSpeakingStream = false
      isProcessing = false
      pendingSpeechCompleteMsg = null
      resetAgentSteps()
      setOrbState('idle')
    } else if (isListening) {
      stopListening()
      setOrbState('idle')
      setVoiceLabel(handsFreeMode ? 'tap to resume' : 'tap to speak')
    }
    return
  }

  if ((e.key === 'h' || e.key === 'H') && !isTyping && !hasMod) {
    e.preventDefault()
    toggleHandsFree()
  }
})

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
if (handsFreeMode) setVoiceLabel('listening...')
