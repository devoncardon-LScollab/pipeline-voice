// Pipeline Voice server: hosts the voice page and turns Pipeline Orbs' answers into speech with your Fish Audio voice.
// The Fish Audio key lives only in Render's environment variables (FISH_API_KEY); it is never sent to the browser.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;
const KEY = process.env.FISH_API_KEY || "";
const VOICE = process.env.FISH_MODEL_ID || "";
const TTS_MODEL = process.env.FISH_TTS_MODEL || "s2.1-pro"; // Fish Audio engine; use s2.1-pro-free on the free developer tier
const PAGE = fs.readFileSync(path.join(__dirname, "index.html"));

// Spending guard: answers are short, so these limits are generous for one person and stop runaway use.
const PER_MINUTE = 30, PER_DAY = 1500, MAX_CHARS = 700;
const hits = new Map(); let day = new Date().toDateString(), today = 0;
function allowed(ip) {
  const now = Date.now(), d = new Date().toDateString();
  if (d !== day) { day = d; today = 0; hits.clear(); }
  const list = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (list.length >= PER_MINUTE || today >= PER_DAY) return false;
  list.push(now); hits.set(ip, list); today++;
  return true;
}
function send(res, code, type, body, extra) {
  res.writeHead(code, Object.assign({ "Content-Type": type, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }, extra || {}));
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 8000) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return send(res, 200, "text/html; charset=utf-8", PAGE, { "Cache-Control": "no-cache" });
  }
  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, "application/json", JSON.stringify({ ok: true, voice: !!(KEY && VOICE) }));
  }
  if (req.method === "POST" && url.pathname === "/speak") {
    // Only the voice page itself: same site, and a custom header other websites can't send without permission.
    const host = req.headers.host || "", origin = req.headers.origin || "";
    if (req.headers["x-pipeline-voice"] !== "1" || (origin && origin !== "https://" + host && origin !== "http://" + host)) return send(res, 403, "text/plain", "Forbidden");
    if (!KEY || !VOICE) return send(res, 503, "text/plain", "Voice not configured");
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (!allowed(ip)) return send(res, 429, "text/plain", "Too many requests");
    let text;
    try { text = String((await readJson(req)).text || "").trim().slice(0, MAX_CHARS); } catch (e) { return send(res, 400, "text/plain", "Bad request"); }
    if (!text) return send(res, 400, "text/plain", "No text");
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch("https://api.fish.audio/v1/tts", {
        method: "POST", signal: ctl.signal,
        headers: { "Authorization": "Bearer " + KEY, "Content-Type": "application/json", "model": TTS_MODEL },
        body: JSON.stringify({ text, reference_id: VOICE, format: "mp3", mp3_bitrate: 128, latency: "balanced", normalize: true }),
      });
      if (!r.ok) { const why = (await r.text()).slice(0, 200); console.error("Fish Audio", r.status, why); return send(res, 502, "text/plain", "Voice service error " + r.status); }
      const audio = Buffer.from(await r.arrayBuffer());
      return send(res, 200, "audio/mpeg", audio, { "Cache-Control": "no-store" });
    } catch (e) {
      console.error("Fish Audio request failed:", e.name === "AbortError" ? "timed out" : e.message);
      return send(res, 504, "text/plain", "Voice service timed out");
    } finally { clearTimeout(timer); }
  }
  send(res, 404, "text/plain", "Not found");
});
server.listen(PORT, () => console.log("Pipeline Voice listening on " + PORT + (KEY && VOICE ? " with Fish Audio voice" : " (FISH_API_KEY or FISH_MODEL_ID not set: built-in voice only)")));
