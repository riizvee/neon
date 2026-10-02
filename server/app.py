import os
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()
KEY = os.getenv("GROQ_API_KEY")
MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
PORT = int(os.getenv("PORT", 5000))
ORIGINS = [os.getenv("CLIENT_ORIGIN", "http://localhost:5173"),
           "http://localhost", "https://localhost", "capacitor://localhost"]
URL = "https://api.groq.com/openai/v1/chat/completions"

app = Flask(__name__)
CORS(app)


@app.get("/api/health")
def health():
    return jsonify(ok=True)


@app.post("/api/chat")
def chat():
    d = request.get_json(force=True)
    name = (d.get("name") or "Nova").strip()[:30]
    history = [m for m in d.get("messages", [])[-20:]
               if m.get("role") in ("user", "assistant")]
    system = (f"You are {name}, a warm, witty, friendly, funniest, who does jokes, and gives you compliments always and helpful female voice assistant who jokes a lot and is very funny. "
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
        r.raise_for_status()
        reply = (r.json()["choices"][0]["message"].get("content") or "").strip()
        return jsonify(reply=reply or "Sorry, I lost my train of thought.")
    except Exception as e:
        return jsonify(error=str(e)), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=True)
