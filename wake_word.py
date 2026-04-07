import json
import os
import queue
import time

import socketio
import sounddevice as sd
import vosk

SERVER_URL = "http://127.0.0.1:5000"
MODEL_PATH = "vosk-model-small-en-us-0.15"
WAKE_PHRASES = ("aiko", "hey aiko")

if not os.path.isdir(MODEL_PATH):
    raise FileNotFoundError(f"Vosk model not found: {MODEL_PATH}")

model = vosk.Model(MODEL_PATH)
audio_queue = queue.Queue()
sio = socketio.Client(reconnection=True)


@sio.event
def connect():
    print("Connected to Flask-SocketIO server")


@sio.event
def disconnect():
    print("Disconnected from Flask-SocketIO server")


def connect_socket():
    while not sio.connected:
        try:
            sio.connect(SERVER_URL)
        except Exception as exc:
            print(f"Socket connection failed: {exc}")
            time.sleep(2)


def callback(indata, frames, time_info, status):
    if status:
        print(status)

    audio_queue.put(bytes(indata))


def contains_wake_phrase(text):
    normalized = text.lower().strip()
    return any(phrase in normalized for phrase in WAKE_PHRASES)


def emit_wake(text):
    if not sio.connected:
        connect_socket()

    sio.emit("wake_event", {"text": text})
    print(f"Wake event emitted: {text}")


def main():
    connect_socket()

    samplerate = 16000
    last_detection = 0
    cooldown = 3

    with sd.RawInputStream(
        samplerate=samplerate,
        blocksize=8000,
        dtype="int16",
        channels=1,
        callback=callback,
    ):
        recognizer = vosk.KaldiRecognizer(
            model,
            samplerate,
            '["aiko", "hey aiko"]',
        )

        print("Listening for wake word...")

        while True:
            data = audio_queue.get()
            current_time = time.time()
            accepted = recognizer.AcceptWaveform(data)

            if accepted:
                result = json.loads(recognizer.Result())
                transcript = result.get("text", "")
            else:
                partial = json.loads(recognizer.PartialResult())
                transcript = partial.get("partial", "")

            if transcript:
                print(f"Heard: {transcript}")

            if contains_wake_phrase(transcript) and current_time - last_detection > cooldown:
                emit_wake(transcript)
                last_detection = current_time


if __name__ == "__main__":
    main()
