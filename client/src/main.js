import "./style.css";
import { Capacitor } from "@capacitor/core";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { TextToSpeech } from "@capacitor-community/text-to-speech";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";
const native = Capacitor.isNativePlatform();
const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

let name = store.get("assistant_name", "");
let role = store.get("assistant_role", "");
let history = store.get("history", []);
let muted = store.get("muted", false);
let busy = false, listening = false;

const setState = (s) => { $("orb").className = s === "idle" ? "" : s; $("status").textContent = s; };
const addMsg = (role, text) => {
  const d = document.createElement("div");
  d.className = "msg " + (role === "user" ? "user" : "bot");
  d.textContent = text; $("log").appendChild(d);
  $("log").scrollTop = $("log").scrollHeight;
};

// ---------- Name ----------
function applyName() {
  $("title").textContent = name.toUpperCase();
  $("overlay").classList.toggle("hide", !!name);
}
const KICKOFF = "[start]";
function greet() {
  if (role) { send(KICKOFF, true); return; }
  const g = `Hi, I'm ${name}. How can I help you?`;
  addMsg("assistant", g); speak(g);
}
$("nameSave").onclick = () => {
  const v = $("nameInput").value.trim(); if (!v) return;
  name = v; store.set("assistant_name", name);
  role = $("roleInput").value.trim(); store.set("assistant_role", role); history = []; store.set("history", history);
  $("log").innerHTML = ""; applyName(); greet();
};
$("nameInput").onkeydown = (e) => { if (e.key === "Enter") $("roleInput").focus(); };
$("roleInput").onkeydown = (e) => { if (e.key === "Enter") $("nameSave").click(); };
$("renameBtn").onclick = () => { $("nameInput").value = name; $("roleInput").value = role; $("overlay").classList.remove("hide"); };

// ---------- Voice out: Edge neural voice from server, device voice as fallback ----------
let audioEl = null, endAudio = null;

function stopSpeech() {
  if (audioEl) { audioEl.pause(); audioEl = null; }
  if (endAudio) { endAudio(); endAudio = null; }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (native) TextToSpeech.stop().catch(() => {});
}

async function speakEdge(text) {
  const r = await fetch(`${API}/api/tts`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error("tts " + r.status);
  const url = URL.createObjectURL(await r.blob());
  try {
    await new Promise((res, rej) => {
      const a = new Audio(url);
      audioEl = a; endAudio = res;
      a.onended = res; a.onpause = res;
      a.onerror = () => rej(new Error("audio error"));
      a.play().catch(rej);
    });
  } finally { URL.revokeObjectURL(url); audioEl = null; endAudio = null; }
}

// Fallback: device voice
const FEMALE = /(female|samantha|zira|aria|jenny|hazel|susan|karen|moira|tessa|victoria|serena)/i;
let webVoice = null;
function pickWebVoice() {
  const v = speechSynthesis.getVoices().filter((x) => x.lang.startsWith("en"));
  webVoice = v.find((x) => FEMALE.test(x.name)) || v[0] || null;
}
if ("speechSynthesis" in window) { pickWebVoice(); speechSynthesis.onvoiceschanged = pickWebVoice; }

let nativeVoiceIdx;
async function speakDevice(text) {
  if (native) {
    if (nativeVoiceIdx === undefined) {
      const { voices } = await TextToSpeech.getSupportedVoices();
      const en = voices.map((v, idx) => ({ ...v, idx })).filter((v) => v.lang.startsWith("en"));
      const best = en.find((v) => /female/i.test(v.name));
      nativeVoiceIdx = best ? best.idx : null;
    }
    const opts = { text, lang: "en-US", rate: 1.0, pitch: 1.0, volume: 1.0, category: "playback" };
    if (nativeVoiceIdx !== null) opts.voice = nativeVoiceIdx;
    await TextToSpeech.speak(opts);
  } else {
    await new Promise((res) => {
      const u = new SpeechSynthesisUtterance(text);
      if (webVoice) u.voice = webVoice;
      u.lang = "en-US"; u.pitch = 1.1; u.rate = 1.05;
      u.onend = u.onerror = res; speechSynthesis.speak(u);
    });
  }
}

async function speak(text) {
  if (muted) return;
  stopSpeech();
  setState("speaking");
  try { await speakEdge(text); }
  catch (e) {
    console.warn("Edge TTS failed, using device voice:", e);
    try { await speakDevice(text); } catch (e2) { console.warn("TTS", e2); }
  }
  setState("idle");
}
$("muteBtn").onclick = () => {
  muted = !muted; store.set("muted", muted); $("muteBtn").textContent = muted ? "🔇" : "🔊";
  if (muted) { stopSpeech(); setState("idle"); }
};
$("muteBtn").textContent = muted ? "🔇" : "🔊";

// ---------- Chat ----------
async function send(text, hidden = false) {
  text = text.trim(); if (!text || busy) return;
  busy = true; if (!hidden) addMsg("user", text);
  history.push({ role: "user", content: text });
  setState("thinking");
  let reply;
  try {
    const r = await fetch(`${API}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, role, messages: history }),
    });
    const j = await r.json();
    reply = j.reply || "Sorry, something went wrong on my end.";
  } catch { reply = "I can't reach my server right now. Please check the connection."; }
  history.push({ role: "assistant", content: reply });
  store.set("history", history.slice(-40));
  addMsg("assistant", reply); busy = false;
  await speak(reply);
}
$("send").onclick = () => { send($("input").value); $("input").value = ""; };
$("input").onkeydown = (e) => { if (e.key === "Enter") $("send").click(); };

// ---------- Voice in ----------
const WebSR = window.SpeechRecognition || window.webkitSpeechRecognition;
async function toggleMic() {
  if (listening) return stopMic();
  stopSpeech();
  listening = true; $("mic").classList.add("on"); setState("listening");
  try {
    if (native) {
      const p = await SpeechRecognition.requestPermissions();
      if (p.speechRecognition !== "granted") throw new Error("denied");
      const res = await SpeechRecognition.start({ language: "en-US", partialResults: false, popup: false });
      stopMic(); if (res?.matches?.[0]) send(res.matches[0]);
    } else {
      if (!WebSR) { addMsg("assistant", "Voice input isn't supported in this browser. Try Chrome."); return stopMic(); }
      const r = new WebSR(); r.lang = "en-US"; r.interimResults = false;
      r.onresult = (e) => send(e.results[0][0].transcript);
      r.onend = r.onerror = stopMic; r.start();
    }
  } catch (e) { console.warn("STT", e); stopMic(); }
}
function stopMic() {
  listening = false; $("mic").classList.remove("on");
  if (!busy) setState("idle");
  if (native) SpeechRecognition.stop().catch(() => {});
}
$("mic").onclick = toggleMic;

// ---------- Boot ----------
applyName();
history.slice(-12).forEach((m) => { if (m.content !== KICKOFF) addMsg(m.role, m.content); });