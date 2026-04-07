# 🌸 Aiko — AI Voice Assistant (Web-Based)

Aiko is a **real-time AI voice assistant** built using Flask and JavaScript, designed to feel like a **calm, intelligent, and interactive presence** — not just a chatbot.

It supports **voice conversations, natural speech output, and lightweight memory**, all inside a modern web interface.

---

## 🌐 Live Demo

👉 https://aiko-web.onrender.com/

---

## 🚀 Features

### 🧠 AI Chat

* Powered by Groq API for fast, intelligent responses
* Context-aware replies within the active session

### 🎤 Voice Interaction

* Browser-based Speech Recognition
* Hands-free conversation mode
* Optional wake-word support (local setup)

### 🔊 Natural Voice Output

* Primary: Azure Neural TTS (`en-US-CoraMultilingualNeural`)
* Fallback: Browser speech synthesis
* Human-like delivery with pauses and chunked speech

### 💾 Lightweight Memory

* Uses **browser localStorage** for identity + session memory
* No server-side storage required
* Fast and simple interaction flow

### 🧩 Real-Time Experience

* Smooth chat updates
* Voice + text modes
* Interruption handling and response control

### 🎨 UI/UX

* Minimal, futuristic interface
* Entry screen with:

  * Voice Conversation
  * Text Chat
* Smooth transitions and auto-scroll chat

---

## 🏗️ Tech Stack

**Backend**

* Flask
* Flask-SocketIO
* Azure Speech SDK
* Groq API

**Frontend**

* HTML, CSS, Vanilla JavaScript
* Web Speech API (SpeechRecognition + fallback TTS)

**Speech**

* Azure Neural TTS
* Browser speech synthesis fallback
* Optional Vosk (offline wake-word)

---

## 📁 Project Structure

```id="z8i06v"
aiko/
│
├── app.py                  # Flask backend + API routes
├── wake_word.py            # Optional wake-word listener
├── requirements.txt        # Dependencies
├── .env                    # Environment variables
├── render.yaml             # Render deployment config
│
├── templates/
│   └── index.html          # Main UI layout
│
├── static/
│   ├── script.js           # Frontend logic (chat + voice)
│   └── style.css           # Styling
│
└── vosk-model/             # Local speech model (optional)
```

---

## ⚙️ Run Locally

### 1. Clone Repository

```bash id="4nvjci"
git clone https://github.com/your-username/aiko.git
cd aiko
```

---

### 2. Create Virtual Environment

```bash id="sc1y6b"
python -m venv .venv
.\.venv\Scripts\activate   # Windows
```

---

### 3. Install Dependencies

```bash id="2gbuv8"
pip install -r requirements.txt
```

---

### 4. Setup Environment Variables

Create `.env` file:

```env id="mfpnzb"
GROQ_API_KEY=your_key
AZURE_TTS_KEY=your_key
AZURE_TTS_REGION=eastus
```

---

### 5. Run App

```bash id="dyssml"
python app.py
```

Open in browser:

```id="e9ll4f"
http://127.0.0.1:5000
```

---

### 6. (Optional) Wake Word

```bash id="v76k4s"
python wake_word.py
```

---

## 🌐 Deployment (Render)

### Setup:

1. Push project to GitHub
2. Create a new Web Service on Render
3. Use:

**Build Command**

```id="q3q4an"
pip install -r requirements.txt
```

**Start Command**

```id="rfazf1"
gunicorn app:socketio -k eventlet -w 1
```

4. Add environment variables in Render dashboard

---

## 💾 Memory System (Current)

Aiko uses **browser-based memory (localStorage)** instead of a database.

### How it works:

* Stores user identity (name + code) locally
* Maintains chat flow within the session
* No backend persistence

### Advantages:

* ⚡ Fast and lightweight
* 🔒 No server-side storage
* 🆓 Works on free hosting

### Limitations:

* ❌ Data lost if cache is cleared
* ❌ Not synced across devices
* ❌ Not secure for sensitive data

---

## 🔊 TTS System

### Primary:

* Azure Neural Voice: `en-US-CoraMultilingualNeural`
* Uses SSML for natural tone (soft, calm delivery)

### Fallback:

* Browser speech synthesis
* Automatically triggered on network/API failure

---

## ⚠️ Known Limitations

* Free hosting may sleep after inactivity (cold start delay)
* Azure TTS may fail on restricted networks
* Browser voice fallback has lower quality
* No persistent backend memory

---

## 🧠 Future Improvements

* PostgreSQL integration for persistent memory
* Secure authentication (session tokens)
* Multi-device sync
* Emotion-based voice modulation
* Avatar + animated UI
* Offline AI mode

---

## 🎯 Vision

Aiko is designed to explore:

> “How can an AI assistant feel like a **presence**, not just a tool?”

---

## 👨‍💻 Author

**Gaurav Singh**
Student | Developer | AI Enthusiast

---

## ⭐ Support

If you like this project, consider giving it a ⭐ on GitHub!

---
