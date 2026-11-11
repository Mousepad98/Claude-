#!/usr/bin/env node
// Kopplung im Terminal, falls du nicht über den Sekretär koppeln willst oder kannst.
//   npm run pair                       → QR-Code im Terminal, mit dem Handy scannen
//   npm run pair -- --phone 4917612345678  → Kopplungscode zum Eintippen am Handy
import QRCode from "qrcode";
import { ensureBridge } from "./mcp.js";
import { bridgeRequest } from "./common.js";

const i = process.argv.indexOf("--phone");
const phone = i > -1 ? String(process.argv[i + 1] || "").replace(/\D/g, "") : null;
const st = await ensureBridge();
if (!st) { console.error("Die Bridge startet nicht. Sieh in ~/.whatsapp-secretary/bridge.log nach."); process.exit(1); }
if (st.connection === "open") { console.log("WhatsApp ist bereits verbunden" + (st.me?.id ? ` (${st.me.id})` : "") + "."); process.exit(0); }

let last = null;
let res = await bridgeRequest("POST", "/pair", phone ? { method: "code", phone } : { method: "qr" }, { timeoutMs: 20000 });
for (;;) {
  const p = res.pairing;
  if (res.connection === "open") { console.log("\n✔ Verbunden. Der Sekretär zeigt jetzt deine Chats."); process.exit(0); }
  if (p?.error) { console.error("\n✖ " + p.error); process.exit(1); }
  if (p?.expired) { console.error("\n✖ Abgelaufen, nichts wurde verbunden. Starte „npm run pair“ erneut."); process.exit(1); }
  if (p?.code && p.code !== last) {
    last = p.code;
    console.log(`\nKopplungscode: ${p.code}\nAm Handy: Benachrichtigung von WhatsApp antippen oder Verknüpfte Geräte → Gerät hinzufügen → „Stattdessen mit Telefonnummer verknüpfen“, dann den Code eingeben.`);
  } else if (p?.qr_raw && p.qr_raw !== last) {
    last = p.qr_raw;
    console.clear();
    console.log(await QRCode.toString(p.qr_raw, { type: "terminal", small: true }));
    console.log("Am Handy: WhatsApp → Einstellungen → Verknüpfte Geräte → Gerät hinzufügen, dann diesen Code scannen. (Er erneuert sich etwa alle 20 Sekunden.)");
  }
  await new Promise((r) => setTimeout(r, 2000));
  res = await bridgeRequest("GET", "/status");
}
