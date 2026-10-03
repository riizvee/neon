import os
import asyncio
import requests
import edge_tts
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()
KEY = (os.getenv("GROQ_API_KEY") or "").strip()
MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
PORT = int(os.getenv("PORT", 5000))
VOICE = os.getenv("TTS_VOICE", "en-US-JennyNeural")
URL = "https://api.groq.com/openai/v1/chat/completions"

app = Flask(__name__)
CORS(app)

if not KEY:
    print("WARNING: GROQ_API_KEY is empty. Set it in server/.env (or Render Environment).")


@app.get("/api/health")
def health():
    return jsonify(ok=True)


@app.post("/api/chat")
def chat():
    d = request.get_json(force=True)
    name = (d.get("name") or "Nova").strip()[:30]
    history = [m for m in d.get("messages", [])[-20:]
               if m.get("role") in ("user", "assistant")]
    system = (f"You are {name}, a warm, witty, friendly, helpful female voice assistant who jokes a lot, is very funny, and always gives the person a genuine compliment. "
              f"Your name is {name}; if asked, say so. "
              "You were built by RIZVI. If asked who made or created you, say RIZVI built you. "
              "If asked what technology or AI model powers you, say you run on a third-party large language model accessed through an API, and don't claim to have trained it yourself. "
              "Reply in 1-3 short conversational sentences. "
              "Plain text only: no markdown, lists, or emojis, because your reply is spoken aloud.")
    try:
        r = requests.post(URL, timeout=60,
                          headers={"Authorization": f"Bearer {KEY}"},
                          json={"model": MODEL,
                                "messages": [{"role": "system", "content": system}] + history,
                                "temperature": 0.8,
                                "max_completion_tokens": 1024,
                                "reasoning_effort": "low"})
        if not r.ok:
            print("GROQ ERROR:", r.status_code, r.text[:400])
            return jsonify(error=r.text), 500
        reply = (r.json()["choices"][0]["message"].get("content") or "").strip()
        return jsonify(reply=reply or "Sorry, I lost my train of thought.")
    except Exception as e:
        print("CHAT ERROR:", repr(e))
        return jsonify(error=str(e)), 500


async def _synth(text):
    buf = bytearray()
    async for ch in edge_tts.Communicate(text, VOICE, rate="+10%").stream():
        if ch["type"] == "audio":
            buf += ch["data"]
    return bytes(buf)


@app.post("/api/tts")
def tts():
    text = (request.get_json(force=True).get("text") or "").strip()[:1000]
    if not text:
        return jsonify(error="no text"), 400
    try:
        audio = asyncio.run(_synth(text))
        if not audio:
            raise RuntimeError("no audio returned")
        return Response(audio, mimetype="audio/mpeg")
    except Exception as e:
        print("TTS ERROR:", repr(e))
        return jsonify(error=str(e)), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=True)