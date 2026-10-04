import os
import re
import json
import asyncio
import requests
import edge_tts
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()
KEY = (os.getenv("GROQ_API_KEY") or "").strip()
MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
PORT = int(os.getenv("PORT", 5000))
VOICE = os.getenv("TTS_VOICE", "en-US-JennyNeural")
URL = "https://api.groq.com/openai/v1/chat/completions"

# language code -> (language name for the prompt, female Edge neural voice)
LANGS = {
    "hi-IN": ("Hindi", "hi-IN-SwaraNeural"),
    "ur-PK": ("Urdu", "ur-PK-UzmaNeural"),
    "ar-SA": ("Arabic", "ar-SA-ZariyahNeural"),
    "es-ES": ("Spanish", "es-ES-ElviraNeural"),
    "fr-FR": ("French", "fr-FR-DeniseNeural"),
    "de-DE": ("German", "de-DE-KatjaNeural"),
    "it-IT": ("Italian", "it-IT-ElsaNeural"),
    "pt-BR": ("Portuguese", "pt-BR-FranciscaNeural"),
    "tr-TR": ("Turkish", "tr-TR-EmelNeural"),
    "bn-IN": ("Bengali", "bn-IN-TanishaaNeural"),
    "zh-CN": ("Chinese", "zh-CN-XiaoxiaoNeural"),
    "ja-JP": ("Japanese", "ja-JP-NanamiNeural"),
}


def voice_for(code):
    return LANGS[code][1] if code in LANGS else VOICE

app = Flask(__name__)
CORS(app)

if not KEY:
    print("WARNING: GROQ_API_KEY is empty. Set it in server/.env (or Render Environment).")


@app.get("/api/health")
def health():
    return jsonify(ok=True)


def build_messages(d):
    name = (d.get("name") or "Nova").strip()[:30]
    role = (d.get("role") or "").strip()[:1000]
    history = [m for m in d.get("messages", [])[-20:]
               if m.get("role") in ("user", "assistant")]
    base = (f"You are {name}, a female voice assistant. Your name is {name}; if asked, say so. "
            "You were built by RIZVI. If asked who made or created you, say RIZVI built you. "
            "If asked what technology or AI model powers you, say you run on a third-party large language model accessed through an API, and don't claim to have trained it yourself. "
            "Your reply is spoken aloud, so use plain text only: no markdown, lists, or emojis. ")
    if role:
        system = (base +
                  f"YOUR ROLE (highest priority, overrides any default personality): {role}. "
                  "If the user's first message is just \"[start]\", that means begin the role right now with your opening line or first question; never mention \"[start]\". Fully act in this role from your very first message and never drop it unless the user clearly asks to stop. "
                  "Take the lead: if the role involves asking questions (like an interviewer, teacher, or coach), ask ONE question at a time, wait for the answer, react briefly to it, then ask the next one. "
                  "Do not just answer or chat; behave exactly like a real person in that role would. "
                  "Keep each reply to 1-3 short sentences and end with your next question when appropriate.")
    else:
        system = (base +
                  "You are warm, witty, friendly and helpful, you joke a lot, and you always give the person a genuine compliment. "
                  "Reply in 1-3 short conversational sentences.")
    system += (" If the user's first message is just \"[start]\", greet them in one short friendly sentence, "
               "introduce yourself by name, and never mention \"[start]\".") if not role else ""
    lang = d.get("lang") or "en-US"
    if lang in LANGS:
        n = LANGS[lang][0]
        system += (f" LANGUAGE (very important): speak and reply ONLY in {n}, in natural everyday {n}, "
                   f"even if the user writes in another language, unless they ask you to switch language.")
    return [{"role": "system", "content": system}] + history


def groq_payload(messages, stream=False):
    p = {"model": MODEL, "messages": messages, "temperature": 0.8,
         "max_completion_tokens": 1024, "reasoning_effort": "low"}
    if stream:
        p["stream"] = True
    return p


@app.post("/api/chat")
def chat():
    d = request.get_json(force=True)
    try:
        r = requests.post(URL, timeout=60,
                          headers={"Authorization": f"Bearer {KEY}"},
                          json=groq_payload(build_messages(d)))
        if not r.ok:
            print("GROQ ERROR:", r.status_code, r.text[:400])
            return jsonify(error=r.text), 500
        reply = (r.json()["choices"][0]["message"].get("content") or "").strip()
        return jsonify(reply=reply or "Sorry, I lost my train of thought.")
    except Exception as e:
        print("CHAT ERROR:", repr(e))
        return jsonify(error=str(e)), 500


@app.post("/api/chat/stream")
def chat_stream():
    d = request.get_json(force=True)
    try:
        r = requests.post(URL, stream=True, timeout=60,
                          headers={"Authorization": f"Bearer {KEY}"},
                          json=groq_payload(build_messages(d), stream=True))
    except Exception as e:
        print("STREAM ERROR:", repr(e))
        return jsonify(error=str(e)), 500
    if not r.ok:
        print("GROQ ERROR:", r.status_code, r.text[:400])
        return jsonify(error=r.text), 500
    r.encoding = "utf-8"

    def gen():
        try:
            for line in r.iter_lines(decode_unicode=True):
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    delta = json.loads(data)["choices"][0]["delta"].get("content")
                except Exception:
                    continue
                if delta:
                    yield delta
        finally:
            r.close()

    return Response(stream_with_context(gen()),
                    mimetype="text/plain; charset=utf-8",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def _synth(text, rate="+10%", voice=None):
    buf = bytearray()
    async for ch in edge_tts.Communicate(text, voice or VOICE, rate=rate).stream():
        if ch["type"] == "audio":
            buf += ch["data"]
    return bytes(buf)


@app.post("/api/tts")
def tts():
    d = request.get_json(force=True)
    text = (d.get("text") or "").strip()[:1000]
    rate = d.get("rate") or "+10%"
    if not re.fullmatch(r"[+-]\d{1,2}%", rate):
        rate = "+10%"
    if not text:
        return jsonify(error="no text"), 400
    try:
        audio = asyncio.run(_synth(text, rate, voice_for(d.get("lang"))))
        if not audio:
            raise RuntimeError("no audio returned")
        return Response(audio, mimetype="audio/mpeg")
    except Exception as e:
        print("TTS ERROR:", repr(e))
        return jsonify(error=str(e)), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=True)