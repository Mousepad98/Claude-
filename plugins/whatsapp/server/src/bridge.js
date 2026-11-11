#!/usr/bin/env node
// WhatsApp-Bridge: hält die Verbindung zu WhatsApp (als "verknüpftes Gerät"),
// speichert Chats lokal und bietet eine kleine HTTP-API nur auf 127.0.0.1.
//
// Gekoppelt wird NIE automatisch: erst wenn du im Sekretär auf "Verbinden" klickst
// (POST /pair), wird ein QR-Code bzw. Kopplungscode erzeugt, den du am Handy
// bestätigen musst. Danach bleiben die Zugangsdaten unter ~/.whatsapp-secretary/auth.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import pino from "pino";
import QRCode from "qrcode";
import {
  makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, jidNormalizedUser,
} from "baileys";
import {
  AUTH_DIR, STORE_FILE, BRIDGE_FILE, DEFAULT_PORT, ensureDir, readJson, writeJson, isRegistered,
} from "./common.js";

const MAX_MESSAGES_PER_CHAT = 50;
const logger = pino({ level: process.env.WA_LOG_LEVEL || "silent" });
const log = (...a) => console.error(new Date().toISOString(), ...a);

// ---------- Zustand ----------
const state = {
  connection: "idle",          // idle | connecting | pairing | open | logged_out
  me: null,
  pairing: null,               // { method, phone, qr, code, expired, error, updatedAt }
  lastError: null,
};
let sock = null;
let generation = 0;            // verhindert, dass Events alter Sockets dazwischenfunken
let reconnectTimer = null;
let reconnectDelay = 2000;
const rawMessages = new Map(); // id -> WAMessage (nur im Speicher, für Zitat-Antworten)

ensureDir();
const store = readJson(STORE_FILE, null) || { chats: {}, contacts: {} };
store.chats ||= {}; store.contacts ||= {};
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.updatedAt = Date.now();
    store.connection = state.connection;
    store.me = state.me;
    try { writeJson(STORE_FILE, store); } catch (e) { log("Speichern fehlgeschlagen:", e.message); }
  }, 800);
}

// ---------- Nachrichten auswerten ----------
const skipJid = (jid) => !jid || jid === "status@broadcast" || jid.endsWith("@newsletter") || jid.endsWith("@broadcast");

function unwrap(m) {
  for (let i = 0; i < 5 && m; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message
      || m.viewOnceMessageV2Extension?.message || m.documentWithCaptionMessage?.message || m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

function textOf(message) {
  const m = unwrap(message);
  if (!m) return null;
  if (m.protocolMessage || m.reactionMessage || m.senderKeyDistributionMessage && Object.keys(m).length === 1) return null;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return "[Bild]" + (m.imageMessage.caption ? " " + m.imageMessage.caption : "");
  if (m.videoMessage) return "[Video]" + (m.videoMessage.caption ? " " + m.videoMessage.caption : "");
  if (m.audioMessage) return m.audioMessage.ptt ? "[Sprachnachricht]" : "[Audio]";
  if (m.documentMessage) return `[Dokument: ${m.documentMessage.fileName || "Datei"}]` + (m.documentMessage.caption ? " " + m.documentMessage.caption : "");
  if (m.stickerMessage) return "[Sticker]";
  if (m.locationMessage || m.liveLocationMessage) return "[Standort]";
  if (m.contactMessage || m.contactsArrayMessage) return "[Kontakt]";
  if (m.pollCreationMessage || m.pollCreationMessageV3) return "[Umfrage] " + ((m.pollCreationMessage || m.pollCreationMessageV3).name || "");
  if (m.buttonsResponseMessage) return m.buttonsResponseMessage.selectedDisplayText || null;
  if (m.listResponseMessage) return m.listResponseMessage.title || null;
  return null;
}

const tsOf = (t) => Number(typeof t === "object" && t?.low != null ? t.low : t) || Math.floor(Date.now() / 1000);

function chatFor(jid) {
  return (store.chats[jid] ||= { jid, name: null, is_group: jid.endsWith("@g.us"), unread_count: 0, last_message_at: 0, messages: [] });
}

function displayName(jid) {
  return store.contacts[jid] || store.chats[jid]?.name || "+" + jid.split("@")[0].split(":")[0];
}

function addMessage(msg, { live = false } = {}) {
  const jid = msg.key?.remoteJid;
  if (skipJid(jid) || !msg.message) return;
  const text = textOf(msg.message);
  if (text == null) return;
  const chat = chatFor(jid);
  const id = msg.key.id;
  if (chat.messages.some((m) => m.id === id)) return;
  const fromMe = !!msg.key.fromMe;
  const senderJid = chat.is_group ? (msg.key.participant || msg.participant) : jid;
  if (!fromMe && msg.pushName && senderJid && !store.contacts[senderJid]) store.contacts[senderJid] = msg.pushName;
  const entry = {
    id, from_me: fromMe, timestamp: tsOf(msg.messageTimestamp), text,
    sender: fromMe ? "Ich" : (msg.pushName || displayName(senderJid || jid)),
  };
  chat.messages.push(entry);
  chat.messages.sort((a, b) => a.timestamp - b.timestamp);
  if (chat.messages.length > MAX_MESSAGES_PER_CHAT) chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT);
  chat.last_message_at = Math.max(chat.last_message_at || 0, entry.timestamp);
  if (live) chat.unread_count = fromMe ? 0 : (chat.unread_count || 0) + 1;
  if (!chat.name && !chat.is_group) chat.name = displayName(jid);
  rawMessages.set(id, msg);
  if (rawMessages.size > 2000) rawMessages.delete(rawMessages.keys().next().value);
}

function bindEvents(s, gen) {
  const live = () => gen === generation;
  s.ev.on("messaging-history.set", ({ chats = [], contacts = [], messages = [] }) => {
    if (!live()) return;
    for (const c of contacts) if (c.id && (c.name || c.notify)) store.contacts[c.id] = c.name || c.notify;
    for (const c of chats) {
      if (skipJid(c.id)) continue;
      const chat = chatFor(c.id);
      if (c.name) chat.name = c.name;
      if (typeof c.unreadCount === "number") chat.unread_count = Math.max(0, c.unreadCount);
    }
    for (const m of messages) addMessage(m);
    saveSoon();
  });
  s.ev.on("contacts.upsert", (list) => { if (!live()) return; for (const c of list) if (c.id && (c.name || c.notify)) store.contacts[c.id] = c.name || c.notify; saveSoon(); });
  s.ev.on("contacts.update", (list) => { if (!live()) return; for (const c of list) if (c.id && (c.name || c.notify)) store.contacts[c.id] = c.name || c.notify; saveSoon(); });
  s.ev.on("chats.upsert", (list) => { if (!live()) return; for (const c of list) { if (skipJid(c.id)) continue; const ch = chatFor(c.id); if (c.name) ch.name = c.name; } saveSoon(); });
  s.ev.on("chats.update", (list) => {
    if (!live()) return;
    for (const c of list) {
      if (skipJid(c.id) || !store.chats[c.id]) continue;
      if (typeof c.unreadCount === "number") store.chats[c.id].unread_count = Math.max(0, c.unreadCount);
      if (c.name) store.chats[c.id].name = c.name;
    }
    saveSoon();
  });
  s.ev.on("messages.upsert", ({ messages, type }) => {
    if (!live()) return;
    for (const m of messages) addMessage(m, { live: type === "notify" });
    saveSoon();
  });
  s.ev.on("groups.update", (list) => { if (!live()) return; for (const g of list) if (g.id && g.subject) chatFor(g.id).name = g.subject; saveSoon(); });
}

// ---------- Verbindung ----------
async function connect(opts = {}) {
  clearTimeout(reconnectTimer);
  const gen = ++generation;
  try { sock?.end?.(undefined); } catch {}
  sock = null;
  if (opts.fresh) { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); }
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch {}
  const registered = !!auth.creds.registered;
  state.connection = registered ? "connecting" : "pairing";
  if (!registered) state.pairing = { method: opts.method || "qr", phone: opts.phone || null, qr: null, code: null, expired: false, error: null, updatedAt: Date.now() };

  const s = makeWASocket({
    auth: auth, logger, version,
    browser: Browsers.macOS("Desktop"),
    markOnlineOnConnect: false,          // Handy bekommt weiter Benachrichtigungen
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });
  sock = s;
  bindEvents(s, gen);
  s.ev.on("creds.update", saveCreds);
  let codeRequested = false;

  s.ev.on("connection.update", async (u) => {
    if (gen !== generation) return;
    const { connection, lastDisconnect, qr } = u;
    if (qr && state.pairing) {
      if (state.pairing.method === "code" && state.pairing.phone) {
        if (!codeRequested) {
          codeRequested = true;
          try {
            const code = await s.requestPairingCode(state.pairing.phone);
            state.pairing.code = code?.match(/.{1,4}/g)?.join("-") || code;
          } catch (e) { state.pairing.error = "Kopplungscode konnte nicht angefordert werden: " + e.message; }
          state.pairing.updatedAt = Date.now();
        }
      } else {
        state.pairing.qr_raw = qr;
        try { state.pairing.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320, errorCorrectionLevel: "M" }); } catch {}
        state.pairing.updatedAt = Date.now();
      }
    }
    if (connection === "open") {
      state.connection = "open";
      state.pairing = null;
      state.lastError = null;
      reconnectDelay = 2000;
      state.me = s.user ? { id: jidNormalizedUser(s.user.id), name: s.user.name || null } : null;
      log("WhatsApp verbunden als", state.me?.id);
      saveSoon();
      try {
        const groups = await s.groupFetchAllParticipating();
        for (const g of Object.values(groups)) if (g.id && g.subject) chatFor(g.id).name = g.subject;
        saveSoon();
      } catch {}
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      log("Verbindung geschlossen, Code", code);
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        state.connection = "logged_out"; state.me = null; state.pairing = null;
        saveSoon();
        return;
      }
      if (code === DisconnectReason.restartRequired) { connect(); return; }   // normal direkt nach dem Koppeln
      if (!isRegistered()) {
        // QR/Code nicht rechtzeitig bestätigt: anhalten, bis du erneut auf "Verbinden" klickst
        state.connection = "idle";
        if (state.pairing) {
          if (!state.pairing.qr && !state.pairing.code && !state.pairing.error) state.pairing.error = `WhatsApp-Server nicht erreichbar (Code ${code ?? "?"}). Internetverbindung prüfen und erneut versuchen.`;
          else state.pairing.expired = true;
          state.pairing.qr = null; state.pairing.updatedAt = Date.now();
        }
        return;
      }
      state.connection = "connecting";
      state.lastError = lastDisconnect?.error?.message || null;
      reconnectTimer = setTimeout(() => connect(), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    }
  });
}

async function logout() {
  generation++;
  try { await sock?.logout(); } catch {}
  try { sock?.end?.(undefined); } catch {}
  sock = null;
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  state.connection = "logged_out"; state.me = null; state.pairing = null;
  saveSoon();
}

function statusPayload() {
  return {
    connection: state.connection,
    registered: isRegistered(),
    me: state.me,
    pairing: state.pairing,
    last_error: state.lastError,
    chats: Object.keys(store.chats).length,
  };
}

// ---------- HTTP-API (nur localhost, nur mit Token) ----------
const token = crypto.randomBytes(24).toString("hex");
const readBody = (req) => new Promise((resolve) => {
  let d = ""; req.on("data", (c) => { d += c; if (d.length > 1e6) req.destroy(); });
  req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const reply = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
  // Browser-Anfragen (z. B. von fremden Webseiten) grundsätzlich ablehnen
  if (req.headers.origin || req.headers.authorization !== `Bearer ${token}`) return reply(403, { error: "forbidden" });
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/status") return reply(200, statusPayload());
    if (req.method === "POST" && url.pathname === "/pair") {
      const body = await readBody(req);
      if (state.connection === "open") return reply(200, statusPayload());
      const method = body.method === "code" ? "code" : "qr";
      const phone = body.phone ? String(body.phone).replace(/\D/g, "") : null;
      if (method === "code" && (!phone || phone.length < 8)) return reply(400, { error: "Für den Kopplungscode brauche ich deine Handynummer mit Ländervorwahl, z. B. 4917612345678." });
      await connect({ method, phone, fresh: !isRegistered() });
      // kurz warten, bis QR/Code da ist
      for (let i = 0; i < 40 && state.pairing && !state.pairing.qr && !state.pairing.code && !state.pairing.error && state.connection !== "open"; i++) await new Promise((r) => setTimeout(r, 250));
      return reply(200, statusPayload());
    }
    if (req.method === "POST" && url.pathname === "/send") {
      const { jid, text, quoted_id } = await readBody(req);
      if (state.connection !== "open" || !sock) return reply(409, { error: "WhatsApp ist nicht verbunden." });
      if (!jid || !text?.trim()) return reply(400, { error: "jid und text sind nötig." });
      const quoted = quoted_id ? rawMessages.get(quoted_id) : undefined;
      const sent = await sock.sendMessage(jid, { text }, quoted ? { quoted } : {});
      if (sent) { addMessage(sent); if (store.chats[jid]) store.chats[jid].unread_count = 0; saveSoon(); }
      try { const last = [...(store.chats[jid]?.messages || [])].reverse().find((m) => !m.from_me); if (last) await sock.readMessages([{ remoteJid: jid, id: last.id, fromMe: false }]); } catch {}
      return reply(200, { ok: true, id: sent?.key?.id || null });
    }
    if (req.method === "POST" && url.pathname === "/logout") { await logout(); return reply(200, statusPayload()); }
    if (req.method === "POST" && url.pathname === "/shutdown") { reply(200, { ok: true }); setTimeout(shutdown, 100); return; }
    reply(404, { error: "not found" });
  } catch (e) {
    log("Fehler:", e);
    reply(500, { error: e.message || String(e) });
  }
});

function shutdown() {
  try { const info = readJson(BRIDGE_FILE, null); if (info?.pid === process.pid) fs.rmSync(BRIDGE_FILE, { force: true }); } catch {}
  clearTimeout(saveTimer);
  store.connection = "unreachable";
  try { writeJson(STORE_FILE, store); } catch {}
  try { sock?.end?.(undefined); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { log(`Port ${DEFAULT_PORT} ist belegt – läuft die Bridge schon?`); process.exit(0); }
  log(e); process.exit(1);
});
server.listen(DEFAULT_PORT, "127.0.0.1", () => {
  writeJson(BRIDGE_FILE, { port: DEFAULT_PORT, token, pid: process.pid, startedAt: Date.now() });
  log(`WhatsApp-Bridge lauscht auf 127.0.0.1:${DEFAULT_PORT}`);
  if (isRegistered()) connect();
  else log("Noch nicht gekoppelt – warte auf „Verbinden“ im Sekretär.");
});
