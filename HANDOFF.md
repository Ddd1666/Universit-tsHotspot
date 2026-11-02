# HANDOFF – Uni-Hotspot lokal auf dem Windows-Laptop installieren & prüfen

Für einen Claude-Chat, der dem Nutzer bei der lokalen Installation hilft. Zielrechner: Windows, Ryzen 7 5800H, 16 GB RAM,
RTX 3060 Laptop (6 GB VRAM), Ollama installiert (`http://127.0.0.1:11434`). Der Nutzer hat das Repo heruntergeladen (Git oder ZIP).
Hintergrund: Phase 1 wurde in einer Linux-Cloud **nur mit Mock-Ollama** getestet. **Phase 2** (Bilder, Scans, Audio/Video) wurde unter
Windows 11 entwickelt, aber ebenfalls **nur gegen Mock-Ollama und Fake-Werkzeuge** (Node-Skripte statt whisper.cpp/ffmpeg) getestet:
233 Unit-/Integrationstests (30× hintereinander grün, Log: `docs/test-logs/phase2.txt`), Browser-E2E 25/25. **Echtes whisper.cpp, echtes ffmpeg, echte Vision-Qualität und
VRAM wurden nie ausgeführt** – genau das prüft Abschnitt 3a. Auf dem Laptop zählt der Test gegen **echtes** Ollama.
**Phase 3** (Lernmodi: Zusammenfassungen, Karteikarten + Wiederholung, Quiz, Wissensgraph) ebenfalls unter Windows 11 entwickelt und
**nur gegen Mock-Ollama** getestet: 299 Unit-/Integrationstests (inkl. Korrekturrunden 1 und 2) (30×-Log: `docs/test-logs/phase3.txt`), Browser-E2E 34/34.
Qualität der KI-Ausgaben, Dauer und VRAM mit echtem Modell sind unbekannt – das prüft Abschnitt 3b (inkl. `npm run eval:learning`).
**Phase 4** (Version 0.4.0: portables Windows-Paket, Sicherung/Wiederherstellung, Export/Import, Erststart-Assistent, Diagnose, Politur)
ebenfalls unter Windows 11 entwickelt und **nur gegen Mock-Ollama** getestet: 361 Unit-/Integrationstests inkl. Korrekturrunde 1 (30×-Logs:
`docs/test-logs/phase4.txt`, `phase4-k1.txt`), Browser-E2E 43/43 (inkl. Wiederherstellen mit Server-Neustart im Browser-Modus). **Das
Windows-Paket (Electron) wurde nie gebaut oder gestartet** – der GitHub-Actions-Workflow ist geschrieben und YAML-geprüft, aber nicht
ausgeführt; geprüft ist nur die Zusammenstellung der App-Dateien. Das prüft Abschnitt 3c zusammen mit Sicherung/Wiederherstellung an
den echten Daten.

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
(Get-Location).Path          # im Projektordner ausführen: Lage prüfen (s. u.)
```

- **Lage des Projektordners:** Die ZIP muss **vollständig entpackt** sein (nicht aus der ZIP-Vorschau bzw. einem `…\Temp\…`-Pfad
  starten). Liegt der Ordner unter **OneDrive** (z. B. `…\OneDrive\Desktop`) oder in **Downloads**, dem Nutzer vorschlagen, ihn nach
  z. B. `%USERPROFILE%\Uni-Hotspot` zu verschieben (Sync/Virenscanner sperren sonst Dateien in `node_modules`). Verschieben macht der
  Nutzer selbst (Explorer); der Datenordner `%USERPROFILE%\Uni-Hotspot-Daten` bleibt davon unberührt.

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
node scripts\check-deps.mjs --write       # Marker setzen, damit start.bat nicht erneut installiert
npm.cmd test                              # optional: alle Tests mit Mock-Ollama (Zahl: docs/test-logs/phase4-k1.txt), schreibt nur nach .\.tmp\tests
npm.cmd run build                         # Web-Oberfläche bauen (dist\web)
```

Hinweis Phase 4: Die Versionsnummer in `package-lock.json` ist auf 0.4.0 gestiegen ⇒ `start.bat` führt beim ersten Start einmal
`npm ci` aus (braucht Internet, 1–3 min; ohne Netz startet der bisherige Stand). Das portable Paket (Abschnitt 3c) braucht weder Node noch `npm`.

Alternativ erledigt **`start.bat`** das selbst (`scripts\ensure-deps.mjs`): es vergleicht den SHA-256 von `package-lock.json` mit
`node_modules\.hotspot-lock-hash` und führt `npm ci` nur beim ersten Start oder nach einem Update (geänderte Lock-Datei) aus –
und nur, wenn `npm ping` die Registry erreicht. **Update braucht Internet:** ohne Netz wird nichts gelöscht; ist eine lauffähige
Installation vorhanden, startet die App mit dem bisherigen Stand („Update braucht Internet“), sonst bricht die Erstinstallation mit Hinweis ab.

Erwartung: `npm ci` ohne Compiler-/node-gyp-Meldungen (Laufzeit nutzt das eingebaute `node:sqlite`; Build-Tools `rolldown`/`lightningcss`
kommen als vorkompilierte `win32-x64-msvc`-Pakete).

## 3. Start & Smoke-Test gegen echtes Ollama

Start: `.\start.bat` (Desktop/Electron) oder **`.\start-browser.bat`** (= `start.bat browser`, öffnet `http://127.0.0.1:4317`).
Kein „MOCK“-Hinweis darf in der Oberfläche erscheinen.
**Erster Desktop-Start:** `start.bat` lädt Electron einmalig (**~100 MB**, von GitHub, nach `node_modules\electron` bzw. `.cache\electron`).
Das ist – neben `npm ci` – die **einzige Netzwerkaktion**; die laufende App spricht nur `127.0.0.1` (Server, Ollama) an. Vorher dem Nutzer
sagen; bei Bedarf (Datenvolumen/Proxy) direkt `start-browser.bat` verwenden – dann wird nichts geladen.

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
- [ ] **Re-Index-Schutz** (solange `bge-m3` noch nicht installiert ist): Embedding-Modell „bge-m3 (nicht installiert)“ wählen →
      Hinweis „Re-Index nicht möglich: Modell … ist nicht installiert …“, Button deaktiviert; Suche nutzt weiter den bestehenden Index.
      Danach `nomic-embed-text` zurückstellen.
- [ ] Optional **bge-m3:** nach `ollama pull bge-m3` (Nutzer) in den Einstellungen wählen → Hinweis „Re-Index nötig“ → „Re-Index starten“
      (Bestätigungsdialog) → Suche testen.
- [ ] **VRAM-Test bge-m3 + Chat (Laptop-Entscheidung):** mit `gemma3:4b`, `num_ctx` 8192 und `bge-m3` eine Chatfrage mit Quellen stellen,
      währenddessen `ollama ps`: Stehen **beide** Modelle mit `100% GPU` da? Ergebnis notieren. Falls nicht (CPU-Anteil, langsame Antworten):
      beim Standard `nomic-embed-text` bleiben oder `num_ctx` 4096 wählen. Ohne diesen Test bleibt `nomic-embed-text` der Standard.
- [ ] **Zweitstart:** während die App läuft, `start.bat` bzw. `start-browser.bat` erneut doppelklicken → Meldung „Uni-Hotspot läuft bereits
      auf http://127.0.0.1:4317 – kein zweiter Start nötig“ (Desktop: Dialog „Im Browser öffnen“); laufende Instanz arbeitet unverändert weiter
      (laufender Import/Chat nicht unterbrochen).
- [ ] **Beenden mit Strg+C** im Konsolenfenster des Browser-Modus („Batchvorgang abbrechen? J“) → danach darf
      `%USERPROFILE%\Uni-Hotspot-Daten\hotspot.lock` nicht mehr existieren; Neustart ohne Fehlermeldung. (Windows-Signalverhalten
      wurde in der Cloud nicht getestet.)
- [ ] **Beenden während eines Imports:** eine große Datei (z. B. PDF mit vielen Seiten) oder ZIP importieren und die App beenden, solange
      sie noch „in Arbeit“ ist → nach dem Neustart wird die Datei automatisch neu eingereiht und fertig verarbeitet (nicht „abgebrochen“).
- [ ] **Update ohne Internet** (optional): WLAN aus, in `package-lock.json` nichts ändern → normaler Start. Nur wenn ein Update ansteht:
      Meldung „Update braucht Internet“, App startet trotzdem mit dem bisherigen Stand.

## 3a. Laptop-Checkliste Phase 2 (Medien) – nach Abschnitt 3

Vorher: **Backup des Datenordners** (Regel 3). Beim ersten Start mit Phase 2 migriert die App die Datenbank (Schema v2 → v3) und legt
**automatisch** eine Kopie unter `%USERPROFILE%\Uni-Hotspot-Daten\backups\hotspot-v2-<Datum>.sqlite` an. In Phase 1 nur gespeicherte
Bilder/Audio/Video und Scan-PDFs werden danach automatisch neu eingereiht.

**3a.1 Migration (nur lesend prüfen)**
- [ ] Nach dem Start: `Get-ChildItem "$env:USERPROFILE\Uni-Hotspot-Daten\backups"` → genau eine Datei `hotspot-v2-…sqlite`.
- [ ] Bibliothek/Chats wie vorher vorhanden; Bilder/Audio aus Phase 1 erscheinen unter *Aufgaben* bzw. „nur gespeichert – Werkzeuge fehlen“.

**3a.2 Bilder & Scans (braucht nur `gemma3:4b`)**
- [ ] *Einstellungen → Medien*: Vision-Modell `gemma3:4b`, Schalter Bilder + Scan-OCR an.
- [ ] Kleine Testmenge importieren und Ergebnis **pro Datei notieren** (Qualität 1–5, Dauer aus *Aufgaben*):
      Foto einer Tafel/Whiteboard · gescannte Buchseite (deutsch) · Screenshot (englisch) · handschriftliche Notiz · Diagramm/Formel.
      Erwartung: Vorschau zeigt „KI-generiert · Text im Bild (OCR)“ und „· Bildbeschreibung“; Suche nach einem Wort aus dem Bild findet es.
- [ ] Gescanntes PDF (ohne Textschicht, mehrere Seiten): Suche nach einem Wort von Seite 3 → Treffer „S. 3“, „KI-generiert“.
      Zusätzlich ein **Schwarz-Weiß-Scan** (typischer Kopierer-/Fax-Scan, 1 Bit) – wird er ebenfalls gelesen? Die PDF bleibt währenddessen „indexiert“.
- [ ] Je eine **WebP-, GIF- und BMP**-Datei: verarbeitet oder Meldung „als PNG/JPG speichern“? (Ollama-Decoder unbekannt) → melden.
- [ ] **VRAM:** während eine Bildanalyse läuft `ollama ps` → `gemma3:4b` mit `100% GPU`, **kein zweites Modell** und kein Neuladen
      (gleiche `num_ctx` wie im Chat). Sekunden pro Bild notieren.
- [ ] **OCR-Entscheidung:** Ist die deutsche OCR des Vision-Modells brauchbar (Umlaute, Fachwörter, Handschrift)? Wenn deutlich schlecht:
      melden – dann wird `tesseract.js` (WASM, ~31 MB + bestätigter Download der Sprachdaten) als Alternative nachgerüstet.

**3a.3 Werkzeuge für Audio/Video (Download nur mit Zustimmung des Nutzers!)**
- [ ] Nutzer fragen. Dann *Einstellungen → Medien → Herunterladen* (Dialog zeigt Dateien, Größen, Ziel `…\tools`) **oder**
      `node scripts\setup-media.mjs` (fragt „j/N“). Standard-Paket: whisper.cpp (8 MB), ffmpeg (115 MB), Modell `small` (488 MB).
      Erwartung: „SHA-256 ok, installiert“; danach Status „installiert“. Proxy-Fehler ⇒ verständliche Meldung, erneuter Start setzt fort.
- [ ] Smart App Control / SmartScreen blockiert `tools\whisper\whisper-cli.exe` oder `tools\ffmpeg\ffmpeg.exe`? → Fehler im Job
      „Medien-Werkzeug ist fehlgeschlagen“; Meldung + Log melden (nichts an Windows-Einstellungen ändern).
- [ ] Prüfen: `& ".\tools\whisper\whisper-cli.exe" -h` und `& ".\tools\ffmpeg\ffmpeg.exe" -version` laufen (nur lesend).

**3a.4 Transkription – Messung entscheidet den Standard**
- [ ] Je eine **5-min-Aufnahme deutsch** und **englisch** (MP3/M4A) importieren. *Aufgaben*: Dauer bis „fertig“ notieren ⇒
      **Rechenzeit pro Audio-Minute** = Dauer / 5. Taskmanager: CPU-Last, RAM von `whisper-cli.exe`.
- [ ] Dasselbe mit Modell `medium-q5_0` (Nutzer lädt es in *Einstellungen → Medien*, Whisper-Modell umstellen, Quelle „Erneut verarbeiten“).
      Qualität (Wörter falsch pro Minute, Fachbegriffe) und Zeit vergleichen ⇒ Empfehlung für den Standard melden.
- [ ] **Lange Vorlesung (≥ 60 min, MP4 oder MKV):** Fortschritt + Restzeit in *Aufgaben*; nach dem ersten Segment die App beenden
      (Konsole Strg+C) und neu starten ⇒ Job läuft **beim nächsten Segment** weiter (Fortschritt nicht bei 0).
- [ ] **Abbrechen** in *Aufgaben* während eines Segments ⇒ Status „abgebrochen“; im Taskmanager kein `whisper-cli.exe`/`ffmpeg.exe` mehr.
- [ ] **Chat-Priorität:** während eine Transkription läuft, eine Chatfrage stellen ⇒ Antwort streamt flüssig; Job zeigt kurz
      „pausiert – Chat hat Vorrang“. `ollama ps` während Chat + Bildanalyse: nur `gemma3:4b` (+ Embedding-Modell), beide `100% GPU`?
- [ ] **Zitat mit Zeit:** Frage zu einer Aussage aus der Aufnahme ⇒ Zitat zeigt `mm:ss–mm:ss`; Klick ⇒ Player im Quellen-Panel springt
      dorthin (auch in der Desktop-App testen). Stimmt die Stelle (± 10 s)?
- [ ] Video mit **Keyframes** (Schalter an, optional): bis 12 Einzelbilder werden beschrieben; Dauer notieren.
- [ ] Defekte Datei (z. B. abgeschnittenes MP3) und DRM-geschützte Datei (iTunes-M4P, falls vorhanden) ⇒ klare Fehlermeldung, kein Absturz.
- [ ] **Löschen** einer Quelle während der Transkription ⇒ Job verschwindet, `%USERPROFILE%\Uni-Hotspot-Daten\tmp\media` leer.

**Was melden (Phase 2):** Ausgaben von `ollama ps` (während Bild- und Chat-Last), Sekunden pro Bild, Rechenzeit pro Audio-Minute
für `small` und `medium-q5_0` (deutsch/englisch), Qualitätsnoten der Testmenge, ob WebP/GIF/BMP gingen, ob SmartScreen/Smart App
Control die Werkzeuge blockierte, Neustart-/Abbruch-Ergebnis, letzte 100 Zeilen `logs\server.log`.

## 3b. Laptop-Checkliste Phase 3 (Lernmodi) – nach Abschnitt 3/3a

Phase 3 wurde unter Windows 11 entwickelt, aber **nur gegen Mock-Ollama** getestet. Über die **Qualität** von Zusammenfassungen, Karten,
Fragen, Bewertungen und Graph sowie über **Dauer und VRAM** mit echtem `gemma3:4b` ist nichts bekannt – genau das prüft dieser Abschnitt.
Vorher: **Backup des Datenordners** (Regel 3). Beim ersten Start migriert die App die Datenbank (Schema v3 → v4) und legt automatisch
`backups\hotspot-v3-<Datum>.sqlite` an. Datenordner aus Zwischenständen von Phase 3 (z. B. Commit de5adee, nie veröffentlicht; Schema v4
wurde danach noch geändert) löschen bzw. durch das v3-Backup ersetzen – nur mit Zustimmung des Nutzers.

**3b.1 Migration (nur lesend)**
- [ ] `Get-ChildItem "$env:USERPROFILE\Uni-Hotspot-Daten\backups"` → zusätzlich eine Datei `hotspot-v3-…sqlite`.
- [ ] Bibliothek, Chats, Medien wie vorher; neuer Eintrag **„Lernen“** in der Seitenleiste.

**3b.2 Zusammenfassung einer langen Quelle (> Kontext)**
- [ ] Ein echtes Skript mit **≥ 50 Seiten** wählen → Bibliothek → Vorschau → **Lernen** → Zusammenfassung, Stufe „Gliederung“ → Starten.
      *Aufgaben*: Fortschritt „Schritt n/m“ (m = Anzahl Textgruppen + 1). **Dauer bis „fertig“ notieren.**
- [ ] Währenddessen `ollama ps` (zweites Fenster): nur `gemma3:4b` (+ Embedding-Modell), **`100% GPU`**, kein Neuladen mit anderem Kontext.
- [ ] *Lernen → Notizen*: Notiz mit „KI-generiert“, Zitate `[n]` klickbar, Quellenliste mit Seiten. **Stichprobe: 3 Zitate öffnen – stimmt die
      Seite?** Inhalt: Note 1–5. Stufe „Klausur-Spickzettel“ erneut erzeugen → deutlich schneller (Zwischenergebnisse im Cache) – Dauer notieren.
- [ ] „Markdown exportieren“ → Datei öffnet sich lesbar in einem Editor, Quellenliste am Ende.

**3b.3 Karteikarten → Lernen**
- [ ] *Erzeugen* → Karteikarten → Fach → Anzahl 20. Dauer notieren. *Karten → Entwürfe*: wie viele brauchbar (Note 1–5)? Falsche verwerfen,
      eine bearbeiten, Rest annehmen. *Aufgaben* zeigt „x Entwürfe · y verworfen · z Duplikate“ (verworfen = Plausibilitätsprüfung).
- [ ] *Wiederholen*: Leertaste, dann **1–4**. Nach „Gut“ erscheint die Karte nicht mehr heute; nach „Nochmal“ kommt sie in derselben Sitzung wieder.
      Am nächsten Tag: Karten mit „Gut“ sind fällig (Intervall 1 Tag), danach 6 Tage.
- [ ] *Statistik*: Heatmap zeigt heute, Trefferquote passt zu den Bewertungen.

**3b.4 Quiz inkl. Freitext**
- [ ] *Quiz* → „Fragen erzeugen“ (Fach, 12) → Start (Üben). Je Frage: Lösung mit Quelle sichtbar? Fragen sinnvoll (Note 1–5)?
- [ ] Kurzantwort zweimal beantworten: einmal richtig, einmal Unsinn → Punktzahl plausibel? Belege sind **wörtliche** Zitate? **Sekunden pro
      Bewertung notieren** (während der Bewertung pausieren Hintergrundjobs).
- [ ] Klausursimulation (3 Fragen, 2 Minuten) → Zeit ablaufen lassen → automatisch bewertet. Noch einmal mit minimiertem Fenster
      ablaufen lassen → beim Wiederherstellen sofort abgegeben (ggf. „verspätet“ markiert), Antworten nicht verloren.
- [ ] Ollama während einer Klausur-Bewertung beenden → Lösung trotzdem sichtbar, Meldung + „Bewertung wiederholen“; Ollama starten →
      Knopf bewertet nach; Verlauf zeigt bis dahin „n ausstehend“.

**3b.5 Wissensgraph**
- [ ] *Erzeugen* → Wissensgraph → Fach. Dauer notieren; Konzepte sinnvoll? Doppelte Begriffe (Singular/Plural, Groß/Klein) zusammengeführt?
- [ ] Ansicht: Zoomen, Verschieben, Knoten anklicken → Quellen/Abschnitte; „Frag dazu“ → Chat mit vorbelegter Frage antwortet mit Zitaten.
      Ein falsches Konzept ausblenden, eines umbenennen. Ansicht „Liste“ mit Tastatur bedienbar (Tab/Enter)?
- [ ] Flüssig? (subjektiv, ggf. bei großem Fach). Windows-Einstellung „Animationseffekte“ aus → Graph erscheint ohne Animation.

**3b.6 Priorität: Generierung nie auf Kosten des Chats**
- [ ] Eine lange Zusammenfassung starten; währenddessen im Chat eine Frage stellen → Antwort streamt sofort (laufender Lernaufruf wird
      abgebrochen und danach wiederholt); *Aufgaben* zeigt kurz „pausiert – Chat hat Vorrang“. Nach der Antwort läuft der Job weiter und wird fertig.
- [ ] `ollama ps` währenddessen: weiterhin nur ein Chat-Modell im VRAM.
- [ ] App während einer Zusammenfassung beenden (Strg+C) und neu starten → Job läuft weiter, bereits fertige Schritte werden übersprungen.

**3b.7 Löschen**
- [ ] Quelle mit Karten/Fragen/Notiz löschen → Karten behalten Text, zeigen „Quelle gelöscht: Name“; Notiz-Verweis „Quelle gelöscht“.

**3b.8 Qualitäts-Bericht (empfohlen, ~10–30 min je nach Dokument)**
```powershell
npm.cmd run eval:learning -- "C:\Pfad\zu\2-3 typischen Unterlagen"
```
Eigener Temp-Datenordner (`.tmp\eval\…`), echter Datenordner bleibt unberührt. Ergebnis: `.tmp\eval\eval-learning-<Zeit>.md` mit allen
Ausgaben und Feldern „Bewertung 1–5“ – vom Nutzer ausfüllen lassen.

**Was melden (Phase 3):** Dauer je Job (Zusammenfassung lang/kurz, 20 Karten, 12 Fragen, Graph), Sekunden je Freitext-Bewertung,
`ollama ps` während Generierung + Chat, Qualitätsnoten (oder den ausgefüllten Eval-Bericht), Anteil verworfener Karten/Fragen,
Neustart-Ergebnis, Auffälligkeiten (falsche Zitate, englische statt deutscher Ausgaben, Fehlermeldungen), letzte 100 Zeilen `logs\server.log`.

## 3c. Finale Laptop-Checkliste Phase 4 (Paket, Sicherung, Migration der echten Daten)

**Zuerst – echte Daten sichern (Pflicht, App beendet, kein Uni-Hotspot-Fenster/Konsolenfenster offen):**
```powershell
Copy-Item -Recurse "$env:USERPROFILE\Uni-Hotspot-Daten" "$env:USERPROFILE\Uni-Hotspot-Daten.vor-phase4-$(Get-Date -Format yyyyMMdd-HHmm)"
(Get-ChildItem -Recurse "$env:USERPROFILE\Uni-Hotspot-Daten" | Measure-Object Length -Sum).Sum / 1MB   # Größe notieren
```
Ohne diese Kopie **nicht** weitermachen. Phase 4 ändert das DB-Schema nicht (bleibt v4); eine Phase-1/2-DB wird wie bisher migriert (Auto-Backup).

**3c.1 Paket holen und entpacken (ohne Admin)**
- [ ] Vor dem ersten Lauf (Nutzer, im Repo): die drei `uses: actions/…@v4` in `.github/workflows/windows-package.yml` auf den
      Commit-SHA der aktuellen v4-Version pinnen (Kommentar im Kopf der Datei; SHA von der Release-Seite der Action, nicht raten).
- [ ] Nutzer startet im GitHub-Repo *Actions → „Windows-Paket“ → Run workflow* (Branch `claude/nifty-goodall-j9oqls`) – erst nach dem
      Push. Erwartung: alle Schritte grün (Typecheck, Lint, Tests, Bauen, Paket, „Rauchtest – Paket startet ohne Admin“). Schlägt ein
      Schritt fehl: Log des Schritts melden.
- [ ] Artefakt **Uni-Hotspot-win-x64** herunterladen (ZIP, ~120–150 MB), Rechtsklick → „Alle extrahieren“ nach `%USERPROFILE%\Uni-Hotspot-Paket`
      (nicht OneDrive/Downloads). Erwartung: Ordner `Uni-Hotspot-0.4.0-win-x64` mit `Uni-Hotspot.exe`, `LIESMICH.txt`, `resources\app\`.
- [ ] `Uni-Hotspot.exe` doppelklicken → **SmartScreen**-Warnung „Der Computer wurde durch Windows geschützt“ → *Weitere Informationen →
      Trotzdem ausführen* (Nutzer selbst). Kein UAC-Dialog darf erscheinen. Blockiert **Smart App Control** das Programm ganz: melden,
      nichts an Windows ändern, weiter mit `start.bat` (Weg B).
- [ ] Start ohne Node.js: Fenster erscheint in < 10 s, kein „MOCK“, Einstellungen zeigen Ollama „Verbunden“. *Diagnose* (Einstellungen →
      Daten → Diagnose): „Electron 44.x“, Schema 4, Datenordner `C:\Users\<Name>\Uni-Hotspot-Daten`, beschreibbar.
- [ ] Startzeit mit Stoppuhr (Doppelklick bis bedienbar) notieren; Taskmanager: RAM aller „Uni-Hotspot“-Prozesse notieren.

**3c.2 Erststart-Assistent** (erscheint einmal, auch bei vorhandenen Daten)
- [ ] Schritte durchklicken: Ollama „läuft (Version …)“, Modelle `gemma3:4b`/`nomic-embed-text` „installiert“. Ein fehlendes Modell zeigt
      einen kopierbaren `ollama pull …`-Befehl (nicht ausführen ohne Zustimmung). Datenordner „beschreibbar“, freier Platz plausibel.
- [ ] „Überspringen“ schließt; `Strg+K` → „Einrichtungsassistent“ öffnet ihn wieder; Esc schließt.

**3c.3 Bestehende Daten (Migration/Kompatibilität)**
- [ ] Bibliothek, Chats, Karten (Wiederholen-Zähler), Notizen, Quiz-Verlauf, Graph wie vorher. `backups\` enthält ggf. `hotspot-v…sqlite` (nur bei Schema < 4).
- [ ] Suche + Chat mit Zitat funktionieren im Paket genauso wie mit `start.bat`.
- [ ] Bibliothek mit „Alle Quellen“: Scrollen bis ganz unten flüssig, Fach-Auswahl einer Zeile öffnet sich normal.
- [ ] Messung für die Entscheidung über eine schnellere Vektorsuche (Projektordner, App beendet, Rechner ruhig, Netzbetrieb; ~3 min,
      ~0,5 GB vorübergehend in `.tmp\bench4`, wird danach gelöscht): `npm run bench:phase4 -- --only search --rounds 5` → alle Zeilen
      melden (inkl. „Rechnerlast“) plus Energiesparplan (`powercfg /getactivescheme`). Synthetisch, 100k Abschnitte, hier gemessen:
      Hybrid ~219 ms. Zusätzlich die **echte** Bibliothek: *Suche* mit 3–4 Begriffen, gefühlt flüssig? Erst bei ruhig > 150 ms mit
      realer Bibliotheksgröße die Empfehlung in README „Messwerte“ (1-Bit-Vorfilter) umsetzen – nicht vorher.

**3c.4 Sicherung & Wiederherstellung real** (*Einstellungen → Daten → Sicherung & Export*)
- [ ] „Jetzt sichern“ → Eintrag „manuell“ mit Dateizahl/Größe; Dauer notieren. Im Explorer: `Uni-Hotspot-Daten\backups\snapshot-…-manual\`
      mit `hotspot.sqlite`, `files\`, `manifest.json`. Freier Platz auf C: sinkt nur um etwa die DB-Größe (Hardlinks).
- [ ] Testweise ein **unwichtiges** Fach anlegen und eine Testquelle importieren, dann die Sicherung **wiederherstellen** (Bestätigung) →
      „Wird wiederhergestellt …“, App lädt neu, Toast „Wiederherstellung abgeschlossen“; Testfach/Testquelle sind weg, alles andere da;
      neuer Eintrag „vor Wiederherstellung“. Desktop-App und Browser-Modus je einmal.
- [ ] Optional Zielordner auf USB-Stick/zweitem Laufwerk setzen → „Jetzt sichern“ → Dateien werden kopiert (dauert länger) → zweite Sicherung
      deutlich schneller (nur neue Dateien). Stick abziehen → Seite zeigt „Zielordner nicht lesbar“, App läuft weiter; „Jetzt sichern“
      meldet einen Fehler statt abzustürzen. Danach Zielordner wieder leeren (= Standard).
- [ ] Zielordner `\\irgendwas\freigabe` oder `C:\x\CON` eintragen → wird abgelehnt (Meldung), nichts gespeichert.
- [ ] Nach einer Wiederherstellung stehen Zielordner/Intervall/Aufbewahrung noch auf den Werten von vorher (nicht auf denen der Sicherung).
- [ ] Automatik: Intervall „alle 6 Stunden“ einstellen, App > 2 min laufen lassen → Eintrag „automatisch“ erscheint; danach wieder 24 h.

**3c.5 Export/Import, PDF, CSV**
- [ ] Ein kleines Fach exportieren (`Uni-Hotspot-Export-<Fach>-<Datum>.zip`, Speichern-Dialog) und sofort wieder importieren → Bericht
      „0 neu, n schon vorhanden“. Die ZIP lässt sich im Explorer öffnen.
- [ ] Notiz → „PDF“: Desktop = Speichern-Dialog, PDF zeigt nur die Notiz mit Quellenliste; Browser-Modus = Druckdialog („Als PDF speichern“).
- [ ] Karteikarten → „Karten als CSV“ → öffnet in Excel mit Umlauten korrekt; optional in Anki importieren (Datei → Importieren).

**3c.6 Diagnose & Robustheit**
- [ ] *Diagnose → Bericht herunterladen*: Datei durchsehen – **keine** Dateinamen, Dokumentinhalte oder Chat-Texte, Benutzername als `<USER>`/`<HOME>`.
- [ ] `logs\` enthält höchstens `server.log` + `.1` … `.3`.
- [ ] Update-Probe: Paket-Ordner umbenennen, ZIP erneut entpacken → Start → Daten unverändert (Datenordner unberührt).

**Was melden (Phase 4):** Workflow-Ergebnis (grün/rot + Log), SmartScreen/Smart App Control-Verhalten, Startzeit + RAM (Paket und `start.bat`),
Dauer „Jetzt sichern“ und Wiederherstellen bei der echten Datenmenge, Größe der Export-ZIP, Auffälligkeiten im Diagnose-Bericht, Fehlermeldungen
(Screenshot), letzte 100 Zeilen `logs\server.log`. **Bei Problemen mit den echten Daten:** App beenden, Datenordner durch die Kopie vom Anfang
ersetzen (nur mit Zustimmung des Nutzers).

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
| Port 4317 belegt (anderes Programm) | „Port 4317 ist belegt (anderes Programm)“ ohne Stacktrace | `$env:HOTSPOT_PORT="4318"; .\start.bat browser` |
| App läuft schon | „Uni-Hotspot läuft bereits auf …“ (mit Pfad der Sperrdatei) | kein Fehler – vorhandenes Fenster/Browser-Tab nutzen. Nach einem Absturz wird eine verwaiste `hotspot.lock` automatisch übernommen (lebende PID **und** antwortender Uni-Hotspot auf dem eingetragenen Port nötig, sonst verwaist – auch bei wiederverwendeter PID) |
| „läuft bereits“, obwohl sicher nichts läuft | Meldung erscheint bei jedem Start | prüfen: kein Uni-Hotspot-Fenster/Konsolenfenster offen, `http://127.0.0.1:<Port>` nicht erreichbar → dann `hotspot.lock` im Datenordner (Pfad steht in der Meldung) **manuell löschen** und neu starten – nur mit Zustimmung des Nutzers |
| Update ohne Internet | „Update braucht Internet“ | kein Fehler: App läuft mit dem bisherigen Stand; Update beim nächsten Start mit Internet |
| ZIP nicht entpackt / OneDrive / Downloads | `npm ci` scheitert mit `EPERM`/`EBUSY`, Start aus `…\Temp\…` | Ordner vollständig entpacken und nach `%USERPROFILE%\Uni-Hotspot` legen (s. Abschnitt 1) |
| Werkzeug-Download blockiert (Proxy/Firewall) | „Download fehlgeschlagen (Internet/Proxy prüfen)“ | `$env:HTTPS_PROXY="http://proxy:port"; $env:NODE_USE_ENV_PROXY="1"; node scripts\setup-media.mjs` – setzt Teil-Downloads fort |
| whisper-cli.exe/ffmpeg.exe durch Smart App Control blockiert | Medien-Job „Werkzeug fehlgeschlagen“ | melden; nicht an Windows-Sicherheitseinstellungen drehen. Bilder/Scans funktionieren weiter (brauchen nur Ollama) |
| Werkzeuge entfernen | – | Ordner `tools` im Projektordner löschen (App beendet); Audio/Video werden dann wieder nur gespeichert |
| Firewall-Dialog | Windows fragt nach Netzwerkzugriff | sollte nicht erscheinen (nur 127.0.0.1); falls doch: „Abbrechen“ – Freigabe ist nicht nötig |
| Paket: SmartScreen / Smart App Control | Warnung bzw. Programm wird blockiert (unsigniert) | SmartScreen: „Weitere Informationen → Trotzdem ausführen“ (Nutzer). Smart App Control: nicht abschalten – `start.bat` nutzen |
| Wiederherstellung hängt beim Neustart | „Wird wiederhergestellt …“ > 2 min | App beenden und neu starten: die Vormerkung `restore-pending.json` wird beim Start zu Ende geführt (idempotent); ist sie ungültig, wird sie verworfen (Meldung) |
| Start schlägt nach Wiederherstellung fehl | Fehlermeldung beim Start | Datenordner-Kopie bzw. Snapshot `…-pre-restore` zurückspielen (README „Manuell“); `restore-pending.json` darf bei beendeter App gelöscht werden |
| Sicherung auf USB/zweites Laufwerk langsam | erste Sicherung dauert | normal (Kopie statt Hardlink); Folgesicherungen verlinken unveränderte Dateien vom vorigen Snapshot |

## 5. Was bei Problemen zu melden ist

- Ausgaben von: `node -v`, `npm.cmd -v`, `ollama --version`, `ollama list`, `ollama ps`, Windows-Version (`winver`).
- Modus (Desktop oder Browser), genaue Schritte, erwartetes vs. tatsächliches Verhalten, Screenshot.
- Am einfachsten: *Einstellungen → Daten → Diagnose → Bericht herunterladen* (Versionen, Status, Größen, bereinigtes Log – ohne
  Dokumentinhalte, Dateinamen, Chat-Texte; Benutzerpfade anonymisiert). Alternativ letzte ~100 Zeilen aus
  `%USERPROFILE%\Uni-Hotspot-Daten\logs\server.log` (seit Phase 4 ohne Dateinamen; Fehlermeldungen können Text enthalten – vor dem Weitergeben ansehen).
- Ergebnis des VRAM-Tests (gemma3:4b @ 8k + bge-m3: beide `100% GPU`?) und ob Strg+C/Zweitstart wie beschrieben funktionierten.
- Bei Installationsfehlern: Ende der `npm ci`-Ausgabe; bei UI-Fehlern im Browser-Modus die Konsole (F12 → Konsole).
- Bei Modellproblemen: Chat-Modell, `num_ctx`, Ausgabe von `ollama ps` während einer Antwort.
