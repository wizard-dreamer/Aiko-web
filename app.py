from datetime import datetime
from io import BytesIO
import os
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from xml.sax.saxutils import escape

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_file
from flask_socketio import SocketIO
from groq import Groq

load_dotenv()

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

system_prompt = (
    "You are Aiko, a helpful real-time voice assistant. "
    "Reply in a warm, calm, intimate, and natural voice. "
    "Keep answers concise, conversational, and easy to speak aloud."
)

client = None
api_key = os.getenv("GROQ_API_KEY")
if api_key:
    client = Groq(api_key=api_key)

azure_tts_key = os.getenv("AZURE_TTS_KEY")
azure_tts_region = os.getenv("AZURE_TTS_REGION")


def is_exit_command(text):
    normalized = text.lower().strip()
    return normalized in {"exit", "stop", "bye", "goodbye"}


def sanitize_tts_text(text):
    cleaned = re.sub(r"\([^)]*\)", " ", text or "")
    cleaned = re.sub(r"\b(uh+h*m*|uh+m+|um+|hmm+|hmmm+|mm+)\b", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def generate_aiko_voice(text):
    if not azure_tts_key or not azure_tts_region:
        raise RuntimeError("Azure TTS is not configured.")

    safe_text = escape(sanitize_tts_text(text))
    ssml = f"""
<speak version="1.0" xml:lang="en-US">
  <voice name="en-US-CoraMultilingualNeural">
    <prosody rate="-8%" pitch="+8%" volume="soft">
      {safe_text}
    </prosody>
  </voice>
</speak>
""".strip()

    endpoint = f"https://{azure_tts_region}.tts.speech.microsoft.com/cognitiveservices/v1"
    req = Request(
        endpoint,
        data=ssml.encode("utf-8"),
        headers={
            "Ocp-Apim-Subscription-Key": azure_tts_key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
            "User-Agent": "Aiko-Web/1.0",
        },
        method="POST",
    )

    try:
        with urlopen(req, timeout=30) as res:
            audio = res.read()
            if not audio:
                raise RuntimeError("Azure TTS returned empty audio.")
            return audio
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Azure REST TTS HTTP {exc.code}: {body[:300]}") from exc
    except URLError as exc:
        raise RuntimeError(f"Azure REST TTS connection failed: {exc.reason}") from exc


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    history = data.get("history") or []

    if not message:
        return jsonify({"reply": "Please enter a message."}), 200

    lowered = message.lower()

    if "time" in lowered:
        now = datetime.now().strftime("%I:%M %p")
        return jsonify({"reply": f"The time is {now}."}), 200

    if "date" in lowered or "day" in lowered:
        today = datetime.now().strftime("%A, %d %B %Y")
        return jsonify({"reply": f"Today is {today}."}), 200

    if is_exit_command(message):
        return jsonify({"reply": "Stopping conversation."}), 200

    if client is None:
        return jsonify({"reply": "GROQ_API_KEY is missing, so chat is unavailable."}), 200

    messages = [{"role": "system", "content": system_prompt}]
    if isinstance(history, list):
        cleaned_history = []
        for item in history[-10:]:
            if not isinstance(item, dict):
                continue
            role = (item.get("role") or "").strip()
            content = (item.get("content") or "").strip()
            if role in {"user", "assistant"} and content:
                cleaned_history.append({"role": role, "content": content})
        messages.extend(cleaned_history)
    messages.append({"role": "user", "content": message})

    try:
        response = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=messages,
        )
    except Exception as exc:
        return jsonify({"reply": f"Chat request failed: {exc}"}), 200

    reply = response.choices[0].message.content or "I couldn't generate a reply."

    return jsonify({"reply": reply}), 200


@app.route("/tts", methods=["POST"])
def tts():
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()

    if not text:
        return jsonify({"error": "Text is required."}), 400

    try:
        audio = generate_aiko_voice(text[:2500])
    except Exception as exc:
        return jsonify({"error": f"TTS failed: {exc}"}), 502

    return send_file(
        BytesIO(audio),
        mimetype="audio/wav",
        as_attachment=False,
        download_name="aiko.wav",
    )


@socketio.on("connect")
def handle_connect():
    print(f"Socket connected: {request.sid}")


@socketio.on("disconnect")
def handle_disconnect():
    print(f"Socket disconnected: {request.sid}")


@socketio.on("wake_event")
def handle_wake_event(data=None):
    payload = data or {}
    detected_text = payload.get("text", "")

    if detected_text:
        print(f"Wake event received: {detected_text}")
    else:
        print("Wake event received")

    socketio.emit("wake_browser", {"text": detected_text})


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"

    socketio.run(
        app,
        host=host,
        port=port,
        debug=debug,
        use_reloader=False,
        allow_unsafe_werkzeug=True,
    )
