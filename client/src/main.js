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
let lang = store.get("assistant_lang", "en-US");
const LANGS = [
  ["en-US", "English"], ["hi-IN", "हिन्दी (Hindi)"], ["ur-PK", "اردو (Urdu)"], ["ar-SA", "العربية (Arabic)"],
  ["es-ES", "Español"], ["fr-FR", "Français"], ["de-DE", "Deutsch"], ["it-IT", "Italiano"],
  ["pt-BR", "Português (Brasil)"], ["tr-TR", "Türkçe"], ["bn-IN", "বাংলা (Bengali)"],
  ["zh-CN", "中文 (Chinese)"], ["ja-JP", "日本語 (Japanese)"],
];
const langEl = document.getElementById("langSelect") || document.createElement("select");
LANGS.forEach(([c, n]) => { const o = document.createElement("option"); o.value = c; o.textContent = n; langEl.appendChild(o); });
langEl.value = lang;
let muted = store.get("muted", false);
let busy = false, listening = false;
const roleEl = document.getElementById("roleInput") || document.createElement("textarea");

const setState = (s) => { $("orb").className = s === "idle" ? "" : s; $("status").textContent = s; };
const addMsg = (role, text) => {
  const d = document.createElement("div");
  d.className = "msg " + (role === "user" ? "user" : "bot");
  d.dir = "auto"; d.textContent = text; $("log").appendChild(d);
  $("log").scrollTop = $("log").scrollHeight;
  return d;
};

// ---------- Name ----------
function applyName() {
  $("title").textContent = name.toUpperCase();
  $("overlay").classList.toggle("hide", !!name);
}
const KICKOFF = "[start]";
function greet() {
  if (role || !lang.startsWith("en")) { send(KICKOFF, true); return; }
  const g = `Hi, I'm ${name}. How can I help you?`;
  addMsg("assistant", g); speak(g);
}
$("nameSave").onclick = () => {
  const v = $("nameInput").value.trim(); if (!v) return;
  name = v; store.set("assistant_name", name);
  role = roleEl.value.trim(); store.set("assistant_role", role);
  lang = langEl.value; store.set("assistant_lang", lang); nativeVoiceIdx = undefined; if ("speechSynthesis" in window) pickWebVoice(); history = []; store.set("history", history);
  $("log").innerHTML = ""; applyName(); greet(); loadFillers();
};
$("nameInput").onkeydown = (e) => { if (e.key === "Enter") roleEl.focus(); };
const grow = (el, max = 220) => { el.style.height = "auto"; const h = el.scrollHeight + 2; el.style.height = Math.min(h, max) + "px"; el.style.overflowY = h > max ? "auto" : "hidden"; };
roleEl.oninput = () => grow(roleEl);
roleEl.onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("nameSave").click(); };
$("renameBtn").onclick = () => { $("nameInput").value = name; roleEl.value = role; langEl.value = lang; $("overlay").classList.remove("hide"); grow(roleEl); };

// ---------- Voice out: speaks sentence by sentence while the reply is still streaming ----------
let gen = 0;                 // bumps on every stopSpeech so stale work is ignored
let queue = [];              // { text, urlP }
let playerRunning = false, streaming = false;
let audioEl = null, endAudio = null, drainWaiters = [];

// "Hmm..." fillers: pre-generated once so they play instantly if the reply is slow
// [text, speed]: a slow speed (like -40%) makes the "hmmm" long and thoughtful
const FILLER_TEXTS = [["OOOH..., ", "-30%"], ["OOOHH..., ", "-25%"], ["OOOOOH..., ", "-35%"]];
const FILLER_DELAY = 900;                 // ms to wait for the first words before saying "hmm"
let fillers = [], fillersLoading = false;
let fillersLang = null;
async function loadFillers() {
  if (fillersLoading || muted || !name) return;
  if (fillersLang !== lang) { fillers.forEach((u) => URL.revokeObjectURL(u)); fillers = []; }
  if (fillers.length) return;
  fillersLoading = true; fillersLang = lang;
const set = FILLER_TEXTS;
  for (const [t, rate] of set) { try { fillers.push(await fetchAudio(t, rate)); } catch { break; } }
  fillersLoading = false;
}
function enqueueFiller() {
  if (muted || !fillers.length) return;
  const url = fillers[Math.floor(Math.random() * fillers.length)];
  queue.push({ text: "", urlP: Promise.resolve(url), keep: true });
  if (!playerRunning) runPlayer();
}

// Speed readout shown under the status text (set SHOW_PERF = false to hide it)
const SHOW_PERF = true;
let perf = { t0: 0, ttft: null, voice: null };
const perfEl = document.createElement("div");
perfEl.style.cssText = "margin-top:4px;font-size:11px;letter-spacing:2px;color:#00f0ff99";
$("status").after(perfEl);
function showPerf() {
  if (!SHOW_PERF || !perf.t0) return;
  const f = (v) => (v == null ? "…" : v.toFixed(1) + "s");
  perfEl.textContent = `words ${f(perf.ttft)} · voice ${f(perf.voice)}`;
}
function markVoice() {
  if (perf.t0 && perf.voice == null) { perf.voice = (performance.now() - perf.t0) / 1000; showPerf(); }
}

const notifyDrain = () => { const w = drainWaiters; drainWaiters = []; w.forEach((f) => f()); };
const drained = () => (!playerRunning && !queue.length) ? Promise.resolve() : new Promise((r) => drainWaiters.push(r));

function stopSpeech() {
  gen++; queue = [];
  if (audioEl) { audioEl.pause(); audioEl = null; }
  if (endAudio) { endAudio(); endAudio = null; }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (native) TextToSpeech.stop().catch(() => {});
  notifyDrain();
}

async function fetchAudio(text, rate) {
  const r = await fetch(`${API}/api/tts`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, rate, lang }),
  });
  if (!r.ok) throw new Error("tts " + r.status);
  return URL.createObjectURL(await r.blob());
}
function playUrl(url) {
  return new Promise((res, rej) => {
    const a = new Audio(url);
    audioEl = a; endAudio = res;
    a.onended = res; a.onpause = res;
    a.onerror = () => rej(new Error("audio error"));
    a.play().catch(rej);
  });
}

// Fallback: device voice
const FEMALE = /(female|samantha|zira|aria|jenny|hazel|susan|karen|moira|tessa|victoria|serena)/i;
let webVoice = null;
function pickWebVoice() {
  const v = speechSynthesis.getVoices().filter((x) => x.lang.startsWith(lang.slice(0, 2)));
  webVoice = v.find((x) => FEMALE.test(x.name)) || v[0] || null;
}
if ("speechSynthesis" in window) { pickWebVoice(); speechSynthesis.onvoiceschanged = pickWebVoice; }
let nativeVoiceIdx;
async function speakDevice(text) {
  if (native) {
    if (nativeVoiceIdx === undefined) {
      const { voices } = await TextToSpeech.getSupportedVoices();
      const en = voices.map((v, idx) => ({ ...v, idx })).filter((v) => v.lang.startsWith(lang.slice(0, 2)));
      const best = en.find((v) => /female/i.test(v.name));
      nativeVoiceIdx = best ? best.idx : null;
    }
    const opts = { text, lang, rate: 1.0, pitch: 1.0, volume: 1.0, category: "playback" };
    if (nativeVoiceIdx !== null) opts.voice = nativeVoiceIdx;
    await TextToSpeech.speak(opts);
  } else {
    await new Promise((res) => {
      const u = new SpeechSynthesisUtterance(text);
      if (webVoice) u.voice = webVoice;
      u.lang = lang; u.pitch = 1.1; u.rate = 1.05;
      u.onend = u.onerror = res; speechSynthesis.speak(u);
    });
  }
}

// Queue: audio for the next sentence is fetched while the current one is playing
function enqueue(text) {
  text = text.trim(); if (!text || muted) return;
  const item = { text, urlP: fetchAudio(text) };
  item.urlP.catch(() => {});
  queue.push(item);
  if (!playerRunning) runPlayer();
}
async function runPlayer() {
  playerRunning = true; const my = gen;
  while (queue.length && my === gen) {
    const item = queue.shift();
    setState("speaking");
    try {
      const url = await item.urlP;
      const drop = () => { if (!item.keep) URL.revokeObjectURL(url); };
      if (my !== gen) { drop(); break; }
      if (!item.keep) markVoice();
      try { await playUrl(url); } finally { drop(); audioEl = null; endAudio = null; }
    } catch (e) {
      if (my !== gen) break;
      console.warn("Edge TTS failed, using device voice:", e);
      if (item.text) { try { await speakDevice(item.text); } catch (e2) { console.warn("TTS", e2); } }
    }
  }
  playerRunning = false;
  if (queue.length) return runPlayer();          // new items arrived after a stop
  if (!streaming && !listening && !busy) setState("idle");
  notifyDrain();
}

// Cut text into sentences as soon as they are complete
function takeSentences(buf, final = false) {
  const out = [];
  const re = /[.!?…]+["')\]]*\s+|\n+/g;
  let start = 0, m;
  while ((m = re.exec(buf))) {
    const end = m.index + m[0].length;
    if (end - start >= 12) { out.push(buf.slice(start, end).trim()); start = end; }
  }
  let rest = buf.slice(start);
  if (!final && rest.length > 160) {            // very long sentence: cut at a comma or space
    const i = Math.max(rest.lastIndexOf(", "), rest.lastIndexOf(" "));
    if (i > 40) { out.push(rest.slice(0, i + 1).trim()); rest = rest.slice(i + 1); }
  }
  if (final && rest.trim()) { out.push(rest.trim()); rest = ""; }
  return [out.filter(Boolean), rest];
}

async function speak(text) {
  if (muted) return;
  stopSpeech();
  setState("speaking");
  const [parts] = takeSentences(text, true);
  parts.forEach(enqueue);
  await drained();
  if (!streaming && !listening && !busy) setState("idle");
}
$("muteBtn").onclick = () => {
  muted = !muted; store.set("muted", muted); $("muteBtn").textContent = muted ? "🔇" : "🔊";
  if (muted) { stopSpeech(); if (!streaming) setState("idle"); }
};
$("muteBtn").textContent = muted ? "🔇" : "🔊";

// ---------- Chat (streamed: text and voice start as soon as the first words arrive) ----------
async function send(text, hidden = false) {
  text = text.trim(); if (!text || busy) return;
  busy = true; if (!hidden) addMsg("user", text);
  history.push({ role: "user", content: text });
  setState("thinking"); stopSpeech();
  const my = gen, enq = (t) => { if (my === gen) enqueue(t); };
  let reply = "", buf = "", bubble = null, failed = false;
  streaming = true;
  perf = { t0: performance.now(), ttft: null, voice: null }; showPerf();
  const fillerTimer = hidden ? null : setTimeout(() => { if (my === gen && !reply) enqueueFiller(); }, FILLER_DELAY);
  const show = () => {
    if (!bubble) bubble = addMsg("assistant", "");
    bubble.textContent = reply; $("log").scrollTop = $("log").scrollHeight;
  };
  const payload = JSON.stringify({ name, role, lang, messages: history });
  const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body: payload };
  try {
    const r = await fetch(`${API}/api/chat/stream`, opts);
    if (!r.ok || !r.body) throw new Error("stream " + r.status);
    const reader = r.body.getReader(), dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      const chunk = dec.decode(value, { stream: true });
      if (perf.ttft == null) { perf.ttft = (performance.now() - perf.t0) / 1000; clearTimeout(fillerTimer); showPerf(); }
      reply += chunk; buf += chunk; show();
      const [sents, rest] = takeSentences(buf); buf = rest; sents.forEach(enq);
    }
  } catch (e) {
    console.warn("stream failed:", e);
    if (!reply) {                                  // fall back to the normal (non-streaming) endpoint
      try {
        const r = await fetch(`${API}/api/chat`, opts);
        const j = await r.json();
        reply = j.reply || ""; 
      } catch { /* handled below */ }
      if (reply) { buf = reply; show(); }
    }
  }
  clearTimeout(fillerTimer);
  if (!reply.trim()) {
    failed = true;
    reply = "I can't reach my server right now. Please check the connection.";
    buf = reply; show();
  }
  const [lastParts] = takeSentences(buf, true); lastParts.forEach(enq);
  streaming = false;
  if (!failed) { history.push({ role: "assistant", content: reply }); store.set("history", history.slice(-40)); }
  else history.pop();                              // don't keep a failed turn in memory
  busy = false;
  await drained();
  console.log(`[speed] first words ${perf.ttft?.toFixed(2)}s, voice started ${perf.voice?.toFixed(2)}s`);
  if (!listening && !busy && !streaming) setState("idle");
}
const chatEl = $("input"); chatEl.dir = "auto";
const isTouch = window.matchMedia("(pointer: coarse)").matches;
function sendFromBox() {
  const v = chatEl.value; if (!v.trim()) return;
  chatEl.value = ""; grow(chatEl, 140);
  send(v);
}
$("send").onclick = sendFromBox;
chatEl.oninput = () => grow(chatEl, 140);
chatEl.onkeydown = (e) => {
  // Desktop: Enter sends, Shift+Enter = new line. Phone: Enter = new line, use the send button.
  if (e.key === "Enter" && !e.shiftKey && !isTouch) { e.preventDefault(); sendFromBox(); }
};

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
      const res = await SpeechRecognition.start({ language: lang, partialResults: false, popup: false });
      stopMic(); if (res?.matches?.[0]) send(res.matches[0]);
    } else {
      if (!WebSR) { addMsg("assistant", "Voice input isn't supported in this browser. Try Chrome."); return stopMic(); }
      const r = new WebSR(); r.lang = lang; r.interimResults = false;
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
applyName(); loadFillers();
history.slice(-12).forEach((m) => { if (m.content !== KICKOFF) addMsg(m.role, m.content); });