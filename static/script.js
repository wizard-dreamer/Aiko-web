const chatbox = document.getElementById("chatbox")
const messageInput = document.getElementById("message")
const entryScreen = document.getElementById("entry-screen")
const mainInterface = document.getElementById("main-interface")
const chatControls = document.getElementById("chat-controls")
const socket = io()
const CHAT_MEMORY_STORAGE_KEY = "aiko_chat_memory_v1"

let speechUnlocked = false
let microphoneReady = false
let microphoneRequest = null
let conversationActive = false
let pendingWake = false
let activeRecognition = null
let recognitionMode = null
let recognitionStarting = false
let interactionMode = null
let currentUtterance = null
let currentAudio = null
let currentAudioUrl = null
let browserFallbackUtterance = null
let currentSpeechText = ""
let interfaceEntered = false
let speechSessionId = 0
let hasLoggedVoiceChoice = false
let isSendingMessage = false
let lastRecognizedNormalized = ""
let lastRecognizedAt = 0
let hasAnnouncedAzureFallback = false
let hasLoggedFallbackVoiceChoice = false
let azureTtsAvailable = true
let chatMemory = loadChatMemory()
const THINK_DELAY_MIN = 350
const THINK_DELAY_MAX = 500
const BETWEEN_SENTENCE_PAUSE_MIN = 200
const BETWEEN_SENTENCE_PAUSE_MAX = 300
const RESET_AFTER_CANCEL_MS = 100
const RECOGNIZED_DUPLICATE_WINDOW_MS = 2500
const RECOGNIZED_MIN_LENGTH = 2

function appendMessage(className, text){
    const node = document.createElement("div")
    node.className = className
    node.textContent = text
    chatbox.appendChild(node)
    scrollChatToBottom()
}

function appendAssistantMessage(text){
    appendMessage("ai", `Aiko: ${text}`)
}

function loadChatMemory(){
    try{
        const raw = window.localStorage.getItem(CHAT_MEMORY_STORAGE_KEY)
        if(!raw){
            return []
        }

        const parsed = JSON.parse(raw)
        if(!Array.isArray(parsed)){
            return []
        }

        return parsed
            .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
            .map((item) => ({role: item.role, content: item.content.trim()}))
            .filter((item) => item.content.length > 0)
            .slice(-40)
    }catch(err){
        console.log("Failed to load chat memory", err)
        return []
    }
}

function persistChatMemory(){
    window.localStorage.setItem(CHAT_MEMORY_STORAGE_KEY, JSON.stringify(chatMemory.slice(-40)))
}

function addChatMemory(role, content){
    if((role !== "user" && role !== "assistant") || !content){
        return
    }

    chatMemory.push({role, content})
    if(chatMemory.length > 40){
        chatMemory = chatMemory.slice(-40)
    }
    persistChatMemory()
}

function clearChatMemory(){
    chatMemory = []
    persistChatMemory()
}

function restoreChatUIFromMemory(){
    if(!chatbox || !Array.isArray(chatMemory)){
        return
    }

    chatbox.innerHTML = ""
    for(const item of chatMemory){
        if(item.role === "user"){
            appendMessage("user", `You: ${item.content}`)
        }else{
            appendMessage("ai", `Aiko: ${item.content}`)
        }
    }
}

restoreChatUIFromMemory()

function scrollChatToBottom(){
    if(!chatbox){
        return
    }

    chatbox.scrollTop = chatbox.scrollHeight

    // Re-apply after layout updates for transitions/late rendering.
    window.requestAnimationFrame(() => {
        chatbox.scrollTop = chatbox.scrollHeight
    })
}

function getRecognitionClass(){
    return window.SpeechRecognition || window.webkitSpeechRecognition
}

function getPreferredBrowserFallbackVoice(){
    const voices = window.speechSynthesis.getVoices() || []
    if(!voices.length){
        return null
    }

    const exactGoogleUkFemale = voices.find(
        (voice) => voice.name.toLowerCase() === "google uk english female"
    )
    if(exactGoogleUkFemale){
        return exactGoogleUkFemale
    }

    const googleUsEnglish = voices.find(
        (voice) => voice.name.toLowerCase() === "google us english"
    )
    if(googleUsEnglish){
        return googleUsEnglish
    }

    const googleFemaleEnglish = voices.find((voice) => {
        const name = voice.name.toLowerCase()
        const lang = (voice.lang || "").toLowerCase()
        return name.includes("google") && name.includes("female") && lang.startsWith("en")
    })
    if(googleFemaleEnglish){
        return googleFemaleEnglish
    }

    const anyFemaleEnglish = voices.find((voice) => {
        const name = voice.name.toLowerCase()
        const lang = (voice.lang || "").toLowerCase()
        return name.includes("female") && lang.startsWith("en")
    })
    if(anyFemaleEnglish){
        return anyFemaleEnglish
    }

    const anyEnglish = voices.find((voice) => (voice.lang || "").toLowerCase().startsWith("en"))
    return anyEnglish || voices[0]
}

function prepareSpeechText(text){
    return text
        .replace(/\([^)]*\)/g, " ")
        .replace(/\b(uh+h*m*|uh+m+|um+|hmm+|hmmm+|mm+)\b/gi, " ")
        .replace(/\s+/g, " ")
        .replace(/([.!?])\s+/g, "$1 ")
        .replace(/\s+,\s+/g, ", ")
        .trim()
}

function humanizeSpeechText(text){
    return prepareSpeechText(text)
}

function splitIntoSpeechChunks(text){
    if(text.length <= 170){
        return [text.trim()]
    }

    const sentenceChunks = text
        .split(/(?<=[.!?])\s+|(?<=\.\.\.)\s+/)
        .map((part) => part.trim())
        .filter(Boolean)

    if(sentenceChunks.length === 0 && text.trim()){
        return [text.trim()]
    }

    const chunks = []

    for(const sentence of sentenceChunks){
        if(sentence.length <= 170){
            chunks.push(sentence)
            continue
        }

        const parts = sentence
            .split(/,\s+|;\s+/)
            .map((part) => part.trim())
            .filter(Boolean)

        if(parts.length > 1){
            for(const part of parts){
                chunks.push(part)
            }
            continue
        }

        chunks.push(sentence)
    }

    return chunks
}

function sleep(ms){
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms)
    })
}

function randomBetween(min, max){
    return Math.floor(Math.random() * (max - min + 1)) + min
}

function normalizeText(text){
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
}

function isExitCommand(text){
    const normalized = normalizeText(text)
    return normalized === "stop" || normalized === "exit" || normalized === "bye" || normalized === "goodbye"
}

function looksLikeAssistantEcho(transcript){
    const heard = normalizeText(transcript)
    const spoken = normalizeText(currentSpeechText)

    if(!heard || !spoken){
        return false
    }

    return spoken.includes(heard) || heard.includes(spoken)
}

function shouldIgnoreRecognizedInput(message){
    const normalized = normalizeText(message)
    const now = Date.now()

    if(normalized.length < RECOGNIZED_MIN_LENGTH){
        return true
    }

    const isDuplicate = normalized === lastRecognizedNormalized
    const inDuplicateWindow = now - lastRecognizedAt < RECOGNIZED_DUPLICATE_WINDOW_MS
    if(isDuplicate && inDuplicateWindow){
        return true
    }

    if(isSendingMessage && inDuplicateWindow){
        return true
    }

    lastRecognizedNormalized = normalized
    lastRecognizedAt = now
    return false
}

function handleMicrophoneDenied(){
    appendAssistantMessage("Please allow microphone access in the browser.")
    conversationActive = false
    pendingWake = false
}

async function requestMicrophoneAccess(){
    if(microphoneReady){
        return true
    }

    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
        return true
    }

    if(microphoneRequest){
        return microphoneRequest
    }

    microphoneRequest = navigator.mediaDevices.getUserMedia({audio:true})
        .then((stream) => {
            console.log("Mic permission granted")
            stream.getTracks().forEach((track) => track.stop())
            microphoneReady = true
            return true
        })
        .catch(() => {
            console.log("Mic permission denied")
            microphoneReady = false
            return false
        })
        .finally(() => {
            microphoneRequest = null
        })

    return microphoneRequest
}

async function unlockSpeechAndMicrophone(){
    await unlockSpeechOutput()

    const micAllowed = await requestMicrophoneAccess()
    if(!micAllowed){
        handleMicrophoneDenied()
        return false
    }

    return true
}

async function unlockSpeechOutput(){
    if(!speechUnlocked){
        speechUnlocked = true
        console.log("Audio output ready")
    }

    return speechUnlocked
}

async function handleUserGesture(){
    if(!conversationActive && !pendingWake){
        return
    }

    const permissionsReady = await unlockSpeechAndMicrophone()

    if(permissionsReady && pendingWake){
        pendingWake = false
        startConversationLoop()
    }
}

document.addEventListener("click", () => {
    void handleUserGesture()
})
document.addEventListener("keydown", () => {
    void handleUserGesture()
})

socket.on("connect", () => {
    console.log("Browser connected to Socket.IO")
})

socket.on("wake_browser", () => {
    console.log("Wake event received by browser")
    beginConversationFromWake()
})

function revealMainInterface(){
    if(interfaceEntered){
        return
    }

    interfaceEntered = true
    document.body.classList.add("aiko-entered")
    mainInterface.setAttribute("aria-hidden", "false")
    chatControls.setAttribute("aria-hidden", "false")

    if(entryScreen){
        entryScreen.classList.add("is-leaving")

        window.setTimeout(() => {
            entryScreen.classList.add("is-hidden")
            entryScreen.setAttribute("aria-hidden", "true")
            scrollChatToBottom()
        }, 380)
    }
}

async function chooseAikoMode(mode){
    if(mode === "voice"){
        interactionMode = "voice"
        messageInput.placeholder = "Speak your thoughts..."
        // Integration point: this reuses the existing browser mic + speech conversation flow.
        revealMainInterface()

        const permissionsReady = await unlockSpeechAndMicrophone()
        if(!permissionsReady){
            return
        }

        window.setTimeout(() => {
            void beginConversationFromUser()
        }, 280)
        return
    }

    // Integration point: text mode only reveals the chat UI and focuses the existing input.
    interactionMode = "text"
    messageInput.placeholder = "Type your thoughts..."
    revealMainInterface()
    await unlockSpeechOutput()

    window.setTimeout(() => {
        messageInput.focus()
    }, 320)
}

function stopRecognition(){
    recognitionStarting = false

    if(!activeRecognition){
        recognitionMode = null
        return
    }

    const recognition = activeRecognition
    activeRecognition = null
    recognitionMode = null

    recognition.onresult = null
    recognition.onerror = null
    recognition.onend = null

    try{
        recognition.stop()
    }catch(err){
        console.log("Recognition stop error", err)
    }
}

function stopCurrentSpeech(){
    speechSessionId += 1
    hasLoggedVoiceChoice = false
    currentUtterance = null
    currentSpeechText = ""

    if(currentAudio){
        currentAudio.pause()
        currentAudio.onplay = null
        currentAudio.onended = null
        currentAudio.onerror = null
        currentAudio = null
    }

    if(currentAudioUrl){
        URL.revokeObjectURL(currentAudioUrl)
        currentAudioUrl = null
    }

    if(window.speechSynthesis.speaking || window.speechSynthesis.pending){
        window.speechSynthesis.cancel()
    }

    browserFallbackUtterance = null
}

async function startRecognition(mode){
    const SpeechRecognitionClass = getRecognitionClass()

    if(!SpeechRecognitionClass){
        appendAssistantMessage("Speech recognition is not supported in this browser.")
        conversationActive = false
        pendingWake = false
        return
    }

    if(activeRecognition || recognitionStarting){
        return
    }

    recognitionStarting = true

    const micAllowed = await requestMicrophoneAccess()
    if(!micAllowed){
        recognitionStarting = false
        handleMicrophoneDenied()
        return
    }

    if((mode === "listen" || mode === "interrupt") && !conversationActive){
        recognitionStarting = false
        return
    }

    if(mode === "interrupt" && !currentUtterance){
        recognitionStarting = false
        return
    }

    const recognition = new SpeechRecognitionClass()
    recognitionStarting = false
    activeRecognition = recognition
    recognitionMode = mode
    recognition.lang = "en-US"
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.continuous = false

    recognition.onresult = function(event){
        const transcript = event.results[event.results.length - 1][0].transcript.trim()

        if(mode === "interrupt" && looksLikeAssistantEcho(transcript)){
            console.log("Ignoring probable TTS echo:", transcript)
            return
        }

        if(mode === "interrupt"){
            stopCurrentSpeech()
        }

        void handleRecognizedText(transcript)
    }

    recognition.onerror = function(event){
        console.log("Speech recognition error", event.error)

        if(event.error === "not-allowed" || event.error === "service-not-allowed"){
            microphoneReady = false
            handleMicrophoneDenied()
            return
        }

        if(event.error !== "no-speech" && event.error !== "aborted"){
            appendAssistantMessage("Microphone input failed.")
            conversationActive = false
            pendingWake = false
        }
    }

    recognition.onend = function(){
        if(activeRecognition !== recognition){
            return
        }

        activeRecognition = null
        recognitionMode = null

        if(mode === "interrupt" && conversationActive && currentUtterance){
            void startRecognition("interrupt")
            return
        }

        if(mode === "listen" && conversationActive && !currentUtterance){
            void startRecognition("listen")
        }
    }

    try{
        recognition.start()
    }catch(err){
        recognitionStarting = false
        activeRecognition = null
        recognitionMode = null
        appendAssistantMessage("Microphone input failed.")
        conversationActive = false
        pendingWake = false
    }
}

async function speakChunk(chunk, options = {}){
    const {
        allowInterrupt = false,
    } = options

    if(!speechUnlocked){
        return false
    }

    const ttsUrl = new URL("tts", window.location.href)
    const response = await fetch(ttsUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({text: chunk}),
    })

    if(!response.ok){
        let message = `TTS failed: ${response.status}`
        try{
            const payload = await response.json()
            if(payload && payload.error){
                message = payload.error
            }
        }catch(err){
            const textBody = await response.text().catch(() => "")
            if(textBody){
                message = `${message} ${textBody.slice(0, 120)}`
            }
            console.log("Failed to parse TTS error response", err)
        }
        throw new Error(message)
    }

    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    currentAudioUrl = url

    return new Promise((resolve) => {
        const audio = new Audio(url)
        currentAudio = audio
        currentUtterance = audio

        audio.onplay = function(){
            currentSpeechText = chunk

            if(!hasLoggedVoiceChoice){
                console.log("Aiko TTS voice: Azure en-US-CoraMultilingualNeural")
                hasLoggedVoiceChoice = true
            }

            stopRecognition()
            if(allowInterrupt && conversationActive){
                void startRecognition("interrupt")
            }
        }

        audio.onended = function(){
            if(currentUtterance === audio){
                currentUtterance = null
            }
            if(currentAudio === audio){
                currentAudio = null
            }
            if(currentAudioUrl){
                URL.revokeObjectURL(currentAudioUrl)
                currentAudioUrl = null
            }

            resolve(true)
        }

        audio.onerror = function(){
            if(currentUtterance === audio){
                currentUtterance = null
            }
            if(currentAudio === audio){
                currentAudio = null
            }
            if(currentAudioUrl){
                URL.revokeObjectURL(currentAudioUrl)
                currentAudioUrl = null
            }

            resolve(false)
        }

        void audio.play().catch(() => {
            if(currentAudioUrl){
                URL.revokeObjectURL(currentAudioUrl)
                currentAudioUrl = null
            }
            resolve(false)
        })
    })
}

function speakChunkBrowserFallback(chunk, options = {}){
    const {
        allowInterrupt = false,
    } = options

    return new Promise((resolve) => {
        const utterance = new SpeechSynthesisUtterance(chunk)
        const fallbackVoice = getPreferredBrowserFallbackVoice()
        browserFallbackUtterance = utterance
        currentUtterance = utterance
        utterance.voice = fallbackVoice
        utterance.lang = "en-GB"
        utterance.rate = 0.88
        utterance.pitch = 1.18
        utterance.volume = 0.84

        utterance.onstart = function(){
            currentSpeechText = chunk

            if(!hasLoggedFallbackVoiceChoice){
                const voiceName = fallbackVoice ? fallbackVoice.name : "Default browser voice"
                const voiceLang = fallbackVoice ? fallbackVoice.lang : utterance.lang
                console.log(`Aiko fallback voice: ${voiceName} (${voiceLang})`)
                hasLoggedFallbackVoiceChoice = true
            }

            stopRecognition()
            if(allowInterrupt && conversationActive){
                void startRecognition("interrupt")
            }
        }

        utterance.onend = function(){
            if(browserFallbackUtterance === utterance){
                browserFallbackUtterance = null
            }
            if(currentUtterance === utterance){
                currentUtterance = null
            }
            resolve(true)
        }

        utterance.onerror = function(){
            if(browserFallbackUtterance === utterance){
                browserFallbackUtterance = null
            }
            if(currentUtterance === utterance){
                currentUtterance = null
            }
            resolve(false)
        }

        window.speechSynthesis.speak(utterance)
    })
}

async function speakAiko(text, options = {}){
    const {
        restartListening = false,
        allowInterrupt = false,
    } = options

    if(!speechUnlocked){
        await unlockSpeechOutput()
    }

    if(!speechUnlocked){
        if(restartListening && conversationActive){
            void startRecognition("listen")
        }
        return
    }

    stopRecognition()
    stopCurrentSpeech()
    await sleep(RESET_AFTER_CANCEL_MS)

    const sessionId = speechSessionId
    const humanized = humanizeSpeechText(text)
    const chunks = splitIntoSpeechChunks(humanized)

    if(chunks.length === 0){
        if(restartListening && conversationActive){
            void startRecognition("listen")
        }
        return
    }

    await sleep(randomBetween(THINK_DELAY_MIN, THINK_DELAY_MAX))

    if(sessionId !== speechSessionId){
        return
    }

    let announcedFallback = false

    for(const chunk of chunks){
        if(sessionId !== speechSessionId){
            return
        }

        let spoken = false

        if(azureTtsAvailable){
            try{
                spoken = await speakChunk(chunk, {allowInterrupt})
            }catch(err){
                azureTtsAvailable = false
                console.log("Azure TTS unavailable for this session, using browser fallback", err)
                if(!announcedFallback && !hasAnnouncedAzureFallback){
                    announcedFallback = true
                    hasAnnouncedAzureFallback = true
                }
                spoken = await speakChunkBrowserFallback(chunk, {allowInterrupt})
            }
        }else{
            spoken = await speakChunkBrowserFallback(chunk, {allowInterrupt})
        }

        if(!spoken || sessionId !== speechSessionId){
            return
        }

        await sleep(randomBetween(BETWEEN_SENTENCE_PAUSE_MIN, BETWEEN_SENTENCE_PAUSE_MAX))
    }

    if(sessionId !== speechSessionId){
        return
    }

    currentSpeechText = ""
    stopRecognition()

    if(restartListening && conversationActive){
        void startRecognition("listen")
    }
}

function speakText(text, options = {}){
    if(interactionMode === "text"){
        return
    }

    void speakAiko(text, options).catch((err) => {
        console.log("Speech synthesis failed", err)
    })
}

function stopConversation(message = "Stopping conversation"){
    conversationActive = false
    pendingWake = false
    stopRecognition()
    stopCurrentSpeech()
    appendAssistantMessage(message)
    speakText(message, {restartListening:false, allowInterrupt:false})
}

function startConversationLoop(){
    interactionMode = "voice"

    if(conversationActive){
        return
    }

    conversationActive = true
    appendAssistantMessage("Yes?")
    speakText("Yes?", {restartListening:true, allowInterrupt:true})
}

function beginConversationFromWake(){
    interactionMode = "voice"

    if(conversationActive || pendingWake){
        return
    }

    if(!speechUnlocked || !microphoneReady){
        pendingWake = true
        appendAssistantMessage("Wake detected. Click once anywhere to enable voice.")
        return
    }

    startConversationLoop()
}

async function beginConversationFromUser(){
    interactionMode = "voice"

    if(conversationActive){
        return
    }

    const permissionsReady = await unlockSpeechAndMicrophone()
    if(!permissionsReady){
        return
    }

    if(conversationActive){
        return
    }

    startConversationLoop()
}

async function handleRecognizedText(transcript){
    const message = transcript.trim()

    if(!message){
        return
    }

    if(shouldIgnoreRecognizedInput(message)){
        return
    }

    console.log("Heard:", message)

    if(isExitCommand(message)){
        stopConversation("Stopping conversation")
        return
    }

    messageInput.value = message
    await sendMessage(message)
}

async function sendMessage(messageOverride = null){
    const message = (messageOverride ?? messageInput.value).trim()

    if(message === ""){
        return
    }

    if(isSendingMessage){
        return
    }

    isSendingMessage = true

    stopRecognition()

    if(currentUtterance){
        stopCurrentSpeech()
    }

    const historySnapshot = chatMemory.slice(-10)
    appendMessage("user", `You: ${message}`)
    addChatMemory("user", message)
    messageInput.value = ""
    await unlockSpeechOutput()
    scrollChatToBottom()

    if(isExitCommand(message)){
        clearChatMemory()
        stopConversation("Stopping conversation")
        return
    }

    try{
        const response = await fetch("/chat", {
            method:"POST",
            headers:{
                "Content-Type":"application/json"
            },
            body: JSON.stringify({
                message:message,
                history: historySnapshot,
            })
        })

        const data = await response.json()
        const reply = data.reply || "I couldn't generate a reply."

        appendAssistantMessage(reply)
        addChatMemory("assistant", reply)
        scrollChatToBottom()
        speakText(reply, {
            restartListening: conversationActive,
            allowInterrupt: conversationActive,
        })
    }catch(err){
        appendAssistantMessage("Unable to reach the server.")
        conversationActive = false
        pendingWake = false
    }finally{
        isSendingMessage = false
    }
}
