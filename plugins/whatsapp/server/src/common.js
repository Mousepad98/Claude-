// Gemeinsame Helfer für Bridge und MCP-Server: Pfade, JSON-Dateien, Bridge-Client.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const DATA_DIR = process.env.WA_SECRETARY_DIR || path.join(os.homedir(), ".whatsapp-secretary");
export const AUTH_DIR = path.join(DATA_DIR, "auth");
export const STORE_FILE = path.join(DATA_DIR, "store.json");      // gehört der Bridge
export const DRAFTS_FILE = path.join(DATA_DIR, "drafts.json");    // gehört dem MCP-Server
export const BRIDGE_FILE = path.join(DATA_DIR, "bridge.json");    // Port + Token der laufenden Bridge
export const LOG_FILE = path.join(DATA_DIR, "bridge.log");
export const DEFAULT_PORT = Number(process.env.WA_BRIDGE_PORT || 47821);

export function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

// Atomar schreiben (tmp + rename), nur für den Besitzer lesbar.
export function writeJson(file, value) {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function isRegistered() {
  const creds = readJson(path.join(AUTH_DIR, "creds.json"), null);
  return !!creds?.registered || !!creds?.me?.id;
}

// ---- Client für die lokale Bridge-HTTP-API ----
export async function bridgeRequest(method, route, body, { timeoutMs = 8000 } = {}) {
  const info = readJson(BRIDGE_FILE, null);
  if (!info?.port || !info?.token) throw Object.assign(new Error("Bridge läuft nicht"), { code: "unreachable" });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}${route}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${info.token}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Bridge-Fehler ${res.status}`), { code: "bridge_error", status: res.status });
    return data;
  } catch (e) {
    if (e.code === "bridge_error") throw e;
    if (e.name === "AbortError") throw Object.assign(new Error("Bridge antwortet nicht (Zeitüberschreitung)"), { code: "timeout" });
    throw Object.assign(new Error("Bridge läuft nicht"), { code: "unreachable" });
  } finally {
    clearTimeout(t);
  }
}
