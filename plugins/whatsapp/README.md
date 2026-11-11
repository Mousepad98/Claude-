# WhatsApp-Konnektor für den persönlichen Sekretär

Dieser lokale Konnektor verbindet den Sekretär (das Artefakt „Persönlicher Sekretär“, früher „Antwort-Eingang“) mit deinem WhatsApp. Er läuft nur auf deinem Rechner.

Er besteht aus zwei Teilen:

- **Bridge** (`server/src/bridge.js`): Sie meldet sich bei WhatsApp als *verknüpftes Gerät* an, genau wie WhatsApp Web. Sie speichert deine Chats lokal unter `~/.whatsapp-secretary/` und bietet eine kleine API an. Diese API ist nur unter `127.0.0.1` erreichbar und braucht ein Token.
- **MCP-Server `whatsapp`** (`server/src/mcp.js`): Die Claude-Desktop-App startet ihn. Er liefert dem Sekretär den Eingang, verwaltet Antwort-Entwürfe und sendet nur über `send_draft`. Gesendet wird also erst, wenn du einen Entwurf im Sekretär bestätigt hast.

## Freigabe: nichts verbindet sich ohne dich

Die Bridge koppelt sich **nie von selbst**. Gekoppelt wird erst, wenn du im Sekretär auf **„Mit WhatsApp verbinden“** klickst. Danach bestätigst du am Handy, auf einem von zwei Wegen:

1. **QR-Code**: Öffne am Handy WhatsApp → Einstellungen → *Verknüpfte Geräte* → *Gerät hinzufügen* und scanne den QR-Code, den der Sekretär anzeigt. Der Code erneuert sich etwa alle 20 Sekunden.
2. **Per Klick mit Kopplungscode**: Gib im Sekretär deine Handynummer mit Ländervorwahl ein, zum Beispiel `4917612345678`. Der Sekretär zeigt dann einen 8-stelligen Code. Gleichzeitig schickt WhatsApp eine Benachrichtigung auf dein Handy. Tippe sie an, oder gehe zu *Verknüpfte Geräte* → *Gerät hinzufügen* → *Stattdessen mit Telefonnummer verknüpfen*, und gib den Code ein.

**Ohne Sekretär, im Terminal:**

```bash
cd plugins/whatsapp/server
npm run pair                              # QR-Code im Terminal
npm run pair -- --phone 4917612345678     # Kopplungscode
```

Der Sekretär erkennt die Verbindung danach von selbst.

### Schaltflächen im Sekretär freischalten (einmalig)

Für „QR-Code anzeigen“, „Kopplungscode anfordern“ und „Trennen“ braucht das Artefakt die Tools `get_status`, `start_pairing` und `logout`. Neue lokale Tools darf nur eine **lokale Claude-Code-Sitzung** freigeben, also `claude` im Terminal oder Claude Code in der Desktop-App. Sie muss auf dem Rechner laufen, auf dem der Konnektor `whatsapp` eingerichtet ist. Ein normaler Chat oder eine Cloud-Sitzung kann das nicht. Bitte dort einmal:

> Veröffentliche `artifacts/persoenlicher-sekretaer.html` neu auf https://claude.ai/artifact/BrpjtLk5uSEQF5W5HgZC3V, mit `capabilities.mcp.servers = [{server: "host:whatsapp", tools: ["get_inbox","create_draft","update_draft","discard_draft","send_draft","get_status","start_pairing","logout"]}]` und `sample: {}`.

Bis dahin zeigt der Sekretär den Terminal-Weg an und erkennt eine im Terminal gestartete Kopplung trotzdem.

Bestätigst du nicht rechtzeitig, läuft die Kopplung ab und es passiert nichts. Mit **„Trennen“** im Sekretär (Tool `logout`) meldest du das Gerät wieder ab, und die lokalen Zugangsdaten werden gelöscht. Abmelden kannst du es auch jederzeit am Handy unter *Verknüpfte Geräte*.

## Installation

Voraussetzungen: Node.js 20 oder neuer und die Claude-Desktop-App.

```bash
cd plugins/whatsapp/server
npm install
```

Trage den Server in die Konfiguration der Claude-Desktop-App ein: Einstellungen → Entwickler → *Konfiguration bearbeiten*. Das öffnet die Datei `claude_desktop_config.json`. Der Name muss genau **`whatsapp`** lauten, denn das Artefakt spricht `host:whatsapp` an.

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/ABSOLUTER/PFAD/ZU/plugins/whatsapp/server/src/mcp.js"]
    }
  }
}
```

Unter Windows sieht der Pfad zum Beispiel so aus: `"C:\\Users\\du\\Claude-\\plugins\\whatsapp\\server\\src\\mcp.js"`.

Starte danach die Claude-Desktop-App neu und öffne den Sekretär darin. Der Sekretär läuft nur in der Desktop-App auf diesem Rechner, nicht im Browser und nicht am Handy.

## Bridge

Der MCP-Server startet die Bridge bei Bedarf selbst im Hintergrund, zum Beispiel beim Klick auf „Verbinden“. Du kannst sie auch von Hand starten, etwa um die Log-Ausgabe zu sehen:

```bash
cd plugins/whatsapp/server
WA_LOG_LEVEL=info npm run bridge
```

Läuft die Bridge nicht, zeigt der Sekretär die zuletzt gespeicherten Nachrichten. Senden geht dann nicht.

## Tools

| Tool | Zweck |
|---|---|
| `get_status` | Verbindungsstatus und laufende Kopplung (QR-Code als PNG-Daten-URL oder Kopplungscode) |
| `start_pairing` | Kopplung starten: `method: "qr"` oder `method: "code"` mit `phone` |
| `logout` | Gerät abmelden, Zugangsdaten löschen |
| `get_inbox` | Ungelesene und unbeantwortete Chats mit den letzten Nachrichten und offenem Entwurf |
| `create_draft` / `update_draft` / `discard_draft` | Antwort-Entwürfe verwalten, ohne etwas zu senden |
| `send_draft` | Bestätigten Entwurf senden |

## Daten und Sicherheit

- Alles liegt in `~/.whatsapp-secretary/` und ist nur für deinen Benutzer lesbar. Mit `WA_SECRETARY_DIR` kannst du einen anderen Ordner wählen.
  - `auth/`: Zugangsdaten des verknüpften Geräts. Gib diesen Ordner nie weiter und committe ihn nie.
  - `store.json`: die letzten 50 Nachrichten pro Chat
  - `drafts.json`: Entwürfe
  - `bridge.json`: Port und zufälliges Token der laufenden Bridge
- Die Bridge nimmt nur Anfragen von `127.0.0.1` mit Token an. Anfragen aus dem Browser (mit `Origin`-Header) lehnt sie ab.
- Der Konnektor setzt sich nicht auf „online“, damit dein Handy weiter Benachrichtigungen bekommt.
- Der Konnektor nutzt die inoffizielle Bibliothek [Baileys](https://github.com/WhiskeySockets/Baileys), also das WhatsApp-Web-Protokoll. Das ist keine offizielle WhatsApp-API. Verwende ihn nur für dein eigenes Konto und nicht für Massennachrichten.

## Test

```bash
npm test
```

Die Tests prüfen den MCP-Server gegen einen künstlichen Datenbestand, ohne echtes WhatsApp.
