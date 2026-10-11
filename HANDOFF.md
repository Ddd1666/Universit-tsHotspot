# HANDOFF – Uni-Hotspot lokal auf dem Windows-Laptop installieren & prüfen

Für einen Claude-Chat, der dem Nutzer bei der lokalen Installation hilft. Zielrechner: Windows, Ryzen 7 5800H, 16 GB RAM,
RTX 3060 Laptop (6 GB VRAM), Ollama installiert (`http://127.0.0.1:11434`). Der Nutzer hat das Repo heruntergeladen (Git oder ZIP).
Hintergrund: Phase 1 wurde in einer Linux-Cloud **nur mit Mock-Ollama** getestet (82 Unit-/Integrationstests + Browser-E2E).
Auf dem Laptop zählt der Test gegen **echtes** Ollama.

## 0. Regeln für dich (lokaler Claude) – zuerst lesen

1. **Nur reversible Schritte.** Arbeite ausschließlich im Projektordner und im Datenordner (`%USERPROFILE%\Uni-Hotspot-Daten`).
2. **Keine Admin-Rechte, nichts Systemweites:** kein `npm install -g`, keine Registry, kein Autostart, keine Firewall-/Defender-Regeln,
   keine dauerhafte Änderung der PowerShell-Ausführungsrichtlinie, keine Treiber/Systempakete. UAC-Dialoge bedient nur der Nutzer selbst.
3. **Vor jeder Änderung Backup:** Datenordner (bei geschlossener App) und ggf. Projektordner kopieren, z. B.
   `Copy-Item -Recurse "$env:USERPROFILE\Uni-Hotspot-Daten" "$env:USERPROFILE\Uni-Hotspot-Daten.bak-$(Get-Date -Format yyyyMMdd-HHmm)"`.
4. **Modelle nie selbst ziehen:** `ollama pull …` nur nach ausdrücklicher Zustimmung des Nutzers (Downloads mehrere GB). Ollama-Konfiguration nicht ändern.
5. Nichts löschen, was der Nutzer nicht ausdrücklich freigibt (insbesondere nicht den Datenordner). Änderungen am Code nur nach Rückfrage und dokumentiert.
6. Prüfungen zuerst **nur lesend** durchführen (Abschnitt 1); bei fehlenden Voraussetzungen dem Nutzer Optionen erklären, nicht eigenmächtig installieren.

## 1. Voraussetzungen prüfen (nur lesend, PowerShell)

```powershell
node -v                      # erwartet: v22.18.0 oder neuer (empfohlen v24.x LTS)
npm.cmd -v                   # npm.cmd statt npm umgeht die PowerShell-Ausführungsrichtlinie
ollama --version
ollama list                  # gemma3:4b und nomic-embed-text sollten erscheinen
Invoke-RestMethod http://127.0.0.1:11434/api/version   # Ollama-Server antwortet?
ollama ps                    # aktuell geladene Modelle (darf leer sein)
nvidia-smi                   # optional: GPU sichtbar, VRAM frei?
```

- **Node fehlt / zu alt:** dem Nutzer vorschlagen (ohne Admin): auf nodejs.org „Windows Binary (.zip)“ der 24-LTS laden, nach
  `%USERPROFILE%\Tools\node` entpacken. Nur für die aktuelle Sitzung nutzen (reversibel):
  `$env:Path = "$env:USERPROFILE\Tools\node;$env:Path"`. Dauerhaft in den Benutzer-PATH eintragen entscheidet der Nutzer selbst.
- **Ollama antwortet nicht:** Nutzer bitten, Ollama über das Startmenü zu starten (oder `ollama serve` in eigenem Fenster).
- **Modelle fehlen:** dem Nutzer die Befehle nennen, er führt sie aus: `ollama pull gemma3:4b`, `ollama pull nomic-embed-text`,
  optional `ollama pull bge-m3` (bessere DE/EN-Embeddings).

## 2. Installation (PowerShell, alles im Projektordner)

```powershell
cd "<Pfad zum Projektordner>"            # Ordner mit package.json und start.bat
$env:npm_config_cache      = "$PWD\.cache\npm"        # npm-Cache im Projektordner halten
$env:electron_config_cache = "$PWD\.cache\electron"   # Electron-Download im Projektordner halten
$env:NODE_COMPILE_CACHE    = "$PWD\.cache\node-compile" # Vite/tsc-Compile-Cache nicht nach %TEMP%
npm.cmd ci --no-audit --no-fund           # exakt nach package-lock.json; keine nativen Kompilierungen nötig
npm.cmd test                              # optional: 82 Tests mit Mock-Ollama, schreibt nur nach .\.tmp
npm.cmd run build                         # Web-Oberfläche bauen (dist\web)
```

Erwartung: `npm ci` ohne Compiler-/node-gyp-Meldungen (Laufzeit nutzt das eingebaute `node:sqlite`; Build-Tools `rolldown`/`lightningcss`
kommen als vorkompilierte `win32-x64-msvc`-Pakete).

## 3. Start & Smoke-Test gegen echtes Ollama

Start: `.\start.bat` (Desktop/Electron; erster Start lädt Electron einmalig in den Projektordner) oder `.\start.bat browser`
(öffnet `http://127.0.0.1:4317`). Kein „MOCK“-Hinweis darf in der Oberfläche erscheinen.

Checkliste (Ergebnis jeweils notieren):

- [ ] **Einstellungen:** „Verbunden“, Ollama-Version, installierte Modelle sichtbar; Chat-Modell `gemma3:4b`, Embedding `nomic-embed-text`, `num_ctx` 8192.
- [ ] **Import:** in der Bibliothek ein Fach anlegen, je eine echte **PDF, DOCX, PPTX** (+ gern XLSX und eine ZIP) per Drag & Drop importieren.
      Erwartung: Status „indexiert“, danach füllt sich der Vektor-Balken (Embeddings). PDF-Vorschau zeigt „S. n“, PPTX „Folie n“.
- [ ] **Suche:** einen Fachbegriff aus der PDF suchen → Treffer mit Datei, Fach, Seite und markiertem Snippet; Modus „Hybrid“.
- [ ] **Chat mit Zitaten:** „Neuer Chat“, Frage zum Inhalt (deutsch) → Antwort streamt, enthält `[1]`, Klick öffnet Quellen-Panel,
      „Öffnen“ zeigt die Originaldatei. Englische Frage → englische Antwort. Frage außerhalb der Unterlagen → Modell sagt, dass die Unterlagen das nicht abdecken.
- [ ] **Neuer Chat / Umbenennen / Löschen** in der Seitenleiste; Neustart der App → Chats und Verlauf sind noch da; Auto-Titel nach erster Antwort.
- [ ] **Denkmodell:** im Chat-Kopf `qwen3:4b` wählen → einklappbarer „Gedankengang“, Antwort getrennt.
- [ ] **VRAM-Check:** während/nach einer Antwort `ollama ps` → Spalte PROCESSOR sollte `100% GPU` zeigen (auch in den Einstellungen unter „Aktuell geladen“).
      Steht dort z. B. `30%/70% CPU/GPU` oder ist die Antwort sehr langsam: in den Einstellungen `num_ctx` auf **4096** senken und erneut testen;
      bei 8B-Modellen ist teilweiser CPU-Betrieb normal.
- [ ] **Ollama-Ausfall:** Ollama beenden → Chat zeigt verständliche Meldung (kein Absturz), Import + Volltextsuche funktionieren weiter;
      Ollama wieder starten → ausstehende Embeddings werden automatisch nachgeholt.
- [ ] Optional **bge-m3:** nach `ollama pull bge-m3` (Nutzer) in den Einstellungen wählen → Hinweis „Re-Index nötig“ → „Re-Index starten“ → Suche testen.

## 4. Bekannte Windows-Risiken & Abhilfe

| Risiko | Symptom | Abhilfe (reversibel) |
|---|---|---|
| Node zu alt (< 22.18) | `start.bat` meldet Version / `ERR_UNKNOWN_FILE_EXTENSION .ts` | Node 24 LTS (portable ZIP, s. o.) |
| PowerShell-Ausführungsrichtlinie | „Ausführen von Skripts ist deaktiviert“ bei `npm` | `npm.cmd …` verwenden oder `start.bat` per Doppelklick/`cmd.exe`; Richtlinie **nicht** ändern |
| Native Module | – (keine zur Laufzeit) | Build-Tools: falls `Cannot find module '@rolldown/binding-win32-x64-msvc'` o. ä.: `node_modules` löschen, `npm.cmd ci` erneut (optionale Abhängigkeiten nicht abschalten: `npm config get omit` muss leer sein) |
| Electron-Download blockiert (Proxy/Firewall) oder Entpacker (natives Modul von Electron) durch Smart App Control/WDAC blockiert | Desktop-Start schlägt fehl, Skript fällt automatisch auf Browser-Modus zurück | `start.bat browser` nutzen – die App ist im Browser voll funktionsfähig |
| SmartScreen / „Mark of the Web“ | Warnung beim Start von `start.bat` | Nutzer: „Weitere Informationen → Trotzdem ausführen“ oder Datei-Eigenschaften → „Zulassen“ |
| Zeilenenden | `start.bat` liefert seltsame Fehler (Labels/Klammern) | `.bat` ist mit CRLF eingecheckt (`-text`); bei Kopie über Editoren prüfen, dass CRLF erhalten bleibt |
| Pfade | Umlaute/Leerzeichen im Benutzernamen, OneDrive | Datenordner liegt bewusst nicht in „Dokumente“ (OneDrive); Pfade werden mit Node-`path` gebildet; bei Problemen `HOTSPOT_DATA_DIR` auf z. B. `C:\UniHotspotDaten` setzen (nur für die Sitzung: `$env:HOTSPOT_DATA_DIR=...`) |
| Virenscanner sperrt neue Dateien | sporadisch `EPERM/EBUSY` beim Import | eingebaute Wiederholung; sonst Import erneut starten (Quelle → „Erneut verarbeiten“) |
| Port 4317 belegt | „Port … ist belegt“ | `$env:HOTSPOT_PORT="4318"; .\start.bat browser` |
| Firewall-Dialog | Windows fragt nach Netzwerkzugriff | sollte nicht erscheinen (nur 127.0.0.1); falls doch: „Abbrechen“ – Freigabe ist nicht nötig |

## 5. Was bei Problemen zu melden ist

- Ausgaben von: `node -v`, `npm.cmd -v`, `ollama --version`, `ollama list`, `ollama ps`, Windows-Version (`winver`).
- Modus (Desktop oder Browser), genaue Schritte, erwartetes vs. tatsächliches Verhalten, Screenshot.
- Letzte ~100 Zeilen aus `%USERPROFILE%\Uni-Hotspot-Daten\logs\server.log` (enthält keine Dokumentinhalte, aber ggf. Dateinamen).
- Bei Installationsfehlern: Ende der `npm ci`-Ausgabe; bei UI-Fehlern im Browser-Modus die Konsole (F12 → Konsole).
- Bei Modellproblemen: Chat-Modell, `num_ctx`, Ausgabe von `ollama ps` während einer Antwort.
