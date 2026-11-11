// Prüft den MCP-Server gegen einen künstlichen Datenbestand (ohne echtes WhatsApp).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-sec-test-"));
const now = Math.floor(Date.now() / 1000);
let client;

before(async () => {
  fs.writeFileSync(path.join(dir, "store.json"), JSON.stringify({
    chats: {
      "491111@s.whatsapp.net": { jid: "491111@s.whatsapp.net", name: "Anna", is_group: false, unread_count: 2, last_message_at: now - 600,
        messages: [{ id: "a1", from_me: true, sender: "Ich", timestamp: now - 9000, text: "Hi" }, { id: "a2", from_me: false, sender: "Anna", timestamp: now - 600, text: "Kommst du morgen?" }] },
      "492222@s.whatsapp.net": { jid: "492222@s.whatsapp.net", name: "Ben", is_group: false, unread_count: 0, last_message_at: now - 300,
        messages: [{ id: "b1", from_me: true, sender: "Ich", timestamp: now - 300, text: "Bis später" }] },
      "123@g.us": { jid: "123@g.us", name: "Gruppe", is_group: true, unread_count: 5, last_message_at: now - 100,
        messages: [{ id: "g1", from_me: false, sender: "Cara", timestamp: now - 100, text: "Hallo alle" }] },
      "493333@s.whatsapp.net": { jid: "493333@s.whatsapp.net", name: "Alt", is_group: false, unread_count: 1, last_message_at: now - 10 * 86400,
        messages: [{ id: "c1", from_me: false, sender: "Alt", timestamp: now - 10 * 86400, text: "alt" }] },
    },
  }));
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(HERE, "../src/mcp.js")], env: { ...process.env, WA_SECRETARY_DIR: dir, WA_BRIDGE_PORT: "47999" } }));
});
after(async () => { await client?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("listet die erwarteten Tools", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["create_draft", "discard_draft", "get_inbox", "get_status", "logout", "send_draft", "start_pairing", "update_draft"]);
});

test("get_inbox filtert unbeantwortete Chats und meldet fehlende Kopplung", async () => {
  const r = await client.callTool({ name: "get_inbox", arguments: { since_hours: 48 } });
  const d = r.structuredContent;
  assert.deepEqual(d.chats.map((c) => c.name), ["Anna"]);
  assert.equal(d.chats[0].messages.at(-1).text, "Kommst du morgen?");
  assert.equal(d.chats[0].draft, null);
  assert.equal(d.bridge.connection, "not_paired");
  const g = (await client.callTool({ name: "get_inbox", arguments: { include_groups: true } })).structuredContent;
  assert.deepEqual(g.chats.map((c) => c.name), ["Gruppe", "Anna"]);
});

test("Entwurf anlegen, ändern, im Eingang sehen, verwerfen", async () => {
  const c = await client.callTool({ name: "create_draft", arguments: { chat: "491111@s.whatsapp.net", text: "Ja!", reply_to_message_id: "a2" } });
  const id = c.structuredContent.draft.id;
  assert.match(c.content[0].text, new RegExp(`Entwurf #${id}`));
  await client.callTool({ name: "update_draft", arguments: { draft_id: id, text: "Ja, bis morgen!" } });
  const inbox = (await client.callTool({ name: "get_inbox", arguments: {} })).structuredContent;
  assert.equal(inbox.chats[0].draft.text, "Ja, bis morgen!");
  assert.equal(inbox.chats[0].draft.reply_to_id, "a2");
  const del = await client.callTool({ name: "discard_draft", arguments: { draft_id: id } });
  assert.equal(del.structuredContent.draft.status, "discarded");
});

test("send_draft ohne Verbindung sendet nicht", async () => {
  const c = await client.callTool({ name: "create_draft", arguments: { chat: "491111@s.whatsapp.net", text: "Test" } });
  const r = await client.callTool({ name: "send_draft", arguments: { draft_id: c.structuredContent.draft.id } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /nicht verbunden|Bridge/);
  await client.callTool({ name: "discard_draft", arguments: { draft_id: c.structuredContent.draft.id } });
});

test("create_draft lehnt unbekannte Chats ab", async () => {
  const r = await client.callTool({ name: "create_draft", arguments: { chat: "x@s.whatsapp.net", text: "Hi" } });
  assert.equal(r.isError, true);
});
