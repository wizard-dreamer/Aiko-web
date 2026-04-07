from datetime import datetime
from io import BytesIO
import hashlib
import os
import re
import sqlite3
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

DB_PATH = "memory.db"

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


def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                name_key TEXT NOT NULL,
                code_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(name_key, code_hash)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                content TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_user_id_id ON messages(user_id, id)"
        )


def normalize_name(name):
    return (name or "").strip()


def normalize_name_key(name):
    return normalize_name(name).lower()


def hash_code(code):
    return hashlib.sha256((code or "").strip().encode("utf-8")).hexdigest()


def get_or_create_user(name, code):
    safe_name = normalize_name(name)
    name_key = normalize_name_key(safe_name)
    code_hash = hash_code(code)

    with get_db_connection() as conn:
        user = conn.execute(
            "SELECT id, name FROM users WHERE name_key = ? AND code_hash = ?",
            (name_key, code_hash),
        ).fetchone()
        if user:
            return user["id"], user["name"]

        conn.execute(
            "INSERT INTO users (name, name_key, code_hash) VALUES (?, ?, ?)",
            (safe_name, name_key, code_hash),
        )
        user_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        return user_id, safe_name


def fetch_recent_messages(user_id, limit=10):
    with get_db_connection() as conn:
        rows = conn.execute(
            """
            SELECT role, content
            FROM messages
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (user_id, limit),
        ).fetchall()

    rows = list(reversed(rows))
    return [{"role": row["role"], "content": row["content"]} for row in rows]


def store_message(user_id, role, content):
    with get_db_connection() as conn:
        conn.execute(
            "INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)",
            (user_id, role, content),
        )


def clear_user_messages(user_id):
    with get_db_connection() as conn:
        conn.execute("DELETE FROM messages WHERE user_id = ?", (user_id,))


def extract_profile_from_message(text):
    content = (text or "").strip()
    if not content:
        return None

    patterns = [
        r"my name is\s+(?P<name>[a-zA-Z0-9 _-]{2,40}).*?(?:secret\s*code|code)\s+(?:is\s+)?(?P<code>[a-zA-Z0-9_-]{3,40})",
        r"name\s+(?P<name>[a-zA-Z0-9 _-]{2,40}).*?(?:secret\s*code|code)\s+(?:is\s+)?(?P<code>[a-zA-Z0-9_-]{3,40})",
    ]

    for pattern in patterns:
        match = re.search(pattern, content, flags=re.IGNORECASE)
        if match:
            name = normalize_name(match.group("name"))
            code = (match.group("code") or "").strip()
            if name and code:
                return {"name": name, "code": code}

    return None


init_db()


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
    profile = data.get("profile") or {}
    name = normalize_name(profile.get("name"))
    code = (profile.get("code") or "").strip()

    if not message:
        return jsonify({"reply": "Please enter a message."}), 200

    extracted = None
    if not name or not code:
        extracted = extract_profile_from_message(message)
        if extracted:
            name = extracted["name"]
            code = extracted["code"]

    if not name or not code:
        return jsonify(
            {
                "reply": (
                    "Before we continue, tell me your name and secret code. "
                    "Example: my name is Alex and secret code moon77."
                ),
                "needs_profile": True,
            }
        ), 200

    user_id, display_name = get_or_create_user(name, code)
    response_profile = {"name": display_name, "code": code}

    if extracted:
        return jsonify(
            {
                "reply": f"Welcome back, {display_name}. I have loaded your memory context.",
                "profile": response_profile,
            }
        ), 200

    lowered = message.lower()

    if "time" in lowered:
        now = datetime.now().strftime("%I:%M %p")
        return jsonify({"reply": f"The time is {now}.", "profile": response_profile}), 200

    if "date" in lowered or "day" in lowered:
        today = datetime.now().strftime("%A, %d %B %Y")
        return jsonify({"reply": f"Today is {today}.", "profile": response_profile}), 200

    if is_exit_command(message):
        return jsonify(
            {
                "reply": f"Stopping conversation, {display_name}. Your memory context is saved.",
                "profile": response_profile,
            }
        ), 200

    if client is None:
        return jsonify(
            {
                "reply": "GROQ_API_KEY is missing, so chat is unavailable.",
                "profile": response_profile,
            }
        ), 200

    store_message(user_id, "user", message)

    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(fetch_recent_messages(user_id, limit=10))

    try:
        response = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=messages,
        )
    except Exception as exc:
        return jsonify({"reply": f"Chat request failed: {exc}", "profile": response_profile}), 200

    reply = response.choices[0].message.content or "I couldn't generate a reply."
    store_message(user_id, "assistant", reply)

    return jsonify({"reply": reply, "profile": response_profile}), 200


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
