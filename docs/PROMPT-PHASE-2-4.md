# AUFTRAG: Uni-Hotspot – Phasen 2, 3 und 4 (Fortsetzung)

> Diesen Text als erste Nachricht in einen neuen Chat einfügen (Repo `ddd1666/universit-tshotspot` anhängen, Basis-Branch
> `claude/nifty-goodall-j9oqls`, Stand `0e6d6b0`). Du bist der Orchestrator. Du setzt die Phasen 2–4 um, **immer eine Phase nach der anderen**.

---

## 0. Arbeitsregeln für dich (gelten für jede Anweisung des Nutzers)

**Nutzer:** Student, nutzt KI gern, will **so wenig Tokens wie möglich ohne Qualitäts-/Mengenverlust**. Antworte **immer knapp, auf Deutsch, im
„ponytail“-Stil** (kurze Sätze, Stichpunkte, keine Floskeln). Triviale Fragen/Einzeiler beantwortest du direkt, ohne Agenten.

**Ablauf für jede nicht-triviale Anweisung (und für jede Phase):**
1. Aus der Anweisung schreibst du zuerst selbst einen präzisen **Auftrags-Prompt**: Ziel, Kontext, betroffene Dateien, Akzeptanzkriterien, harte Grenzen.
2. **Senior-Dev** (Agent, Modell `opus`): sehr erfahrener Senior-Entwickler, setzt um. **Misst vorher/nachher**, wo sinnvoll. **Vor Änderungen Backup** (Git-Commit/Tag reicht im Repo; bei Nutzerdaten echtes Backup).
3. Sobald der Dev fertig ist, **parallel**:
   - **Kritiker** (Agent, `opus`): perfekter Kritiker, prüft den Diff gegen den Auftrag: Bugs, Randfälle, Sicherheit, Over-Engineering. Nur lesend.
   - **Tester** (Agent, `sonnet`): probiert alles praktisch aus (Tests, App, Browser/Playwright, Randfälle, Angriffe). Ändert keinen Repo-Code.
4. Befunde **per `SendMessage` an denselben Dev** zurück (Kontext bleibt), **max. 2–3 Runden**. Danach gezielte Nachprüfung durch Kritiker/Tester (dieselben Agenten per `SendMessage` fortsetzen). Die Agenten kommunizieren nur über dich.
5. **Kurzer Schlussbericht** an den Nutzer: was gemacht, was getestet (Zahlen), was offen, was seine Zustimmung braucht.

**Regeln:**
- **Laptop = heiliger Gegenstand:** alles reversibel, **keine System-/Admin-Änderungen**, UAC macht der Nutzer selbst. Installationen nur im Projekt-/Datenordner (bzw. Benutzerprofil), nie global, nie Registry/Autostart/Firewall.
- Keine Pull Requests ohne ausdrückliche Bitte. Entwickeln, committen und pushen **nur auf dem vorgegebenen Branch** (Standard: `claude/nifty-goodall-j9oqls`). Ist dessen PR bereits gemerged: Branch-Name behalten, aber von der aktuellen Default-Branch neu aufsetzen (`git fetch origin <default> && git checkout -B <branch> origin/<default>`), nie auf gemergte Historie stapeln.
- Nach außen wirkende/schwer umkehrbare Aktionen (Pushen auf fremde Branches, Löschen, Netz-Downloads großer Dateien, Modelle pullen) **vorher bestätigen lassen**.
- Berichte **ehrlich**: Fehlschläge mit Ausgabe nennen, Übersprungenes sagen. **Behaupte nie „läuft auf dem Laptop“, wenn nur gegen das Mock-Ollama getestet wurde.**
- Das separate Projekt **„Kompass“** (`C:\Users\parsi\OneDrive\Desktop\Kompass\`) ist **tabu und unabhängig**. Dessen Sonderregeln (sw.js-Cache hochzählen, 69 Tests) gelten **nicht** für Uni-Hotspot.
- Kein Modellname/Modell-Identifier in Commit-Messages, Code-Kommentaren oder Dateien im Repo. Commit-Trailer (am Ende jeder Commit-Message) wie vom Harness vorgegeben (Co-Authored-By + Claude-Session).
- Agenten-Hygiene (aus Phase 1 gelernt): Jeder Agent arbeitet in **eigenem Unterordner im Scratchpad**; **niemals** Prozesse per Musterabgleich beenden (`pkill -f`, `killall`) – nur selbst gestartete PIDs (ein Kritiker hat so versehentlich Prozesse des Testers beendet).

---

## 1. Produkt in einem Absatz

**Uni-Hotspot** ist eine lokale Windows-Desktop-App (Studien-Hub). Alles Studienmaterial (Skripte, Folien, Tabellen, Notizen, Bilder, Audio,
Video, ZIPs – „alles“) wird in einen Ordner geworfen; eine **lokale KI (Ollama)** nimmt es auf, analysiert es gründlich, speichert alles und
hilft beim Bearbeiten: Hybrid-Suche, RAG-Chat mit Quellenangaben, später Lernmodi. **100 % lokal** (keine Cloud-KI, keine Telemetrie, nach Setup keine
Netzaktionen außer `127.0.0.1`). Futuristisches, interaktives Design. **Jede Session = ein eigener, persistenter Chat.** UI Deutsch (Standard) + Englisch;
Inhalte deutsch/englisch gemischt. Vollständig unabhängig von Kompass.

---

## 2. Stand heute (Phase 1 – fertig, gepusht, nur gegen Mock-Ollama getestet)

Repo-Root: `README.md` (ausführlich, lesen!), `HANDOFF.md` (Übergabe an den Claude auf dem Laptop), `docs/screenshots/`.

**Tech:** Node ≥ 22.18 (TypeScript läuft direkt per Type-Stripping, **kein Build-Schritt für den Server**), `node:sqlite` (SQLite + FTS5, **keine nativen npm-Module**),
Fastify (nur `127.0.0.1`), React 19 + Vite (UI), Electron 44 als Hülle (läuft auch im Browser-Modus), `unpdf` (PDF), `yauzl` (ZIP), `marked` + `dompurify` + `katex` (Markdown).
vitest: **148 Tests grün**, ESLint + `tsc` (Server + Web) sauber, Browser-E2E 19/19 (`scripts/e2e-browser.mjs`, braucht Playwright), `npm run bench` (Mock).

**Kartenskizze (`git ls-files` für Details):**
```
electron/main.ts, messages.ts         Desktop-Hülle (contextIsolation, sandbox, CSP, Sperrdatei-Dialog)
server/app.ts, main.ts, config.ts      Komposition, Start, Pfade/Einstellungen
server/db.ts                           SQLite-Schema (PRÜFEN: Versionierung/Migrationen vorhanden? – siehe 6.4)
server/storage.ts                      content-addressed Originaldateien (files/ab/<sha256>), tmp-Handling
server/lock.ts                         hotspot.lock (PID + Port + /api/health-Check)
server/ingest/                         detect.ts, ingest.ts (Queue), extractors/{registry,office,pdf,plain}.ts,
                                       chunker.ts, zip.ts, worker-pool.ts + extract-worker.ts (Worker-Thread), types.ts
server/embed/                          embed-queue.ts (persistent, Retry), vector-store.ts (SQLite-BLOB + Brute-Force, int8-Cache)
server/search/hybrid.ts                FTS5-BM25 + Vektor, RRF
server/chat/                           chat-service.ts (Sessions, Streaming, Abbruch, Auto-Titel), prompt.ts (Token-Budget), think.ts
server/ollama/                         client.ts, status.ts (/api/tags, /api/ps), mock.ts
server/http/                           routes.ts, security.ts (Token/Host/Origin), sse.ts, web.ts
server/library.ts, settings.ts, events.ts
web/src/                               App, store.tsx, i18n.ts, views/{Chat,Library,Search,Settings}, components/*, lib/*
scripts/                               start.mjs, dev.mjs, ensure-deps.mjs, check-*.mjs, bench.ts, e2e-browser.mjs, mock-ollama.ts
tests/                                 19 Dateien, Fixtures zur Laufzeit erzeugt, pro Testdatei isolierte Temp-Ordner (.tmp/tests)
start.bat (CRLF, ASCII), start-browser.bat, start.sh
```

**Funktional (Phase 1):** Import (Drag&Drop, Ordner, ZIP mit Zip-Slip-/Bomben-Schutz; PDF/DOCX/PPTX/XLSX/CSV/ODF/MD/TXT/HTML/JSON/Code; **jede** Datei wird gespeichert, SHA-256-Dedupe),
strukturbewusstes Chunking (nie über Seiten-/Folien-/Blattgrenzen), persistente Embedding-Queue (Ollama-Ausfall tolerant, holt nach), Hybrid-Suche mit Quellenangabe,
RAG-Chat (Streaming, Stopp, Regenerate, nummerierte klickbare Zitate, Wissensbereich wählbar, Denk-Blöcke einklappbar, Auto-Titel), Fächer-CRUD,
Settings (Modelle live aus `/api/tags`, `num_ctx` 8192, Re-Index nur mit installiertem Modell + Bestätigung), Strg+K, DE/EN, Hell/Dunkel, Barrierefreiheit (Kontrast AA getestet).
**Bilder/Audio/Video/Unbekanntes sind nur gespeichert** (Status `unsupported`/`phase2_media`) – das ist der Einstiegspunkt für Phase 2.

**Gemessen (Mock):** PDF 400 S. ≈ 1,3 s (~600 Chunks/s); Hybrid-Suche p50 ≈ 28 ms bei 10k Chunks; Bibliotheksliste 2000 Quellen ≈ 28–90 ms; Import eines
40-MB-Texts blockiert den Event-Loop max. ~100 ms.

**Bewusste Entscheidungen (nicht stillschweigend ändern):**
- Kein LanceDB: SQLite-BLOB + Brute-Force hinter dem `VectorStore`-Interface (LanceDB zog ~1,1 GB `node_modules`, Windows-Binary 340 MB). Neu bewerten **nur**, wenn Messungen Brute-Force bei realer Bibliotheksgröße als zu langsam zeigen (Schwelle z. B. Hybrid p50 > 150 ms).
- Text > 32 MB wird nur zu 32 MB indexiert (Datei bleibt vollständig gespeichert, UI warnt „teilweise indexiert“).
- Das Zugriffstoken steht in Datei-Link-URLs (nur lokal, pro Start neu) – akzeptiert.
- Embedding-Standard `nomic-embed-text` (vorhanden, aber englisch-lastig); `bge-m3` optional, erst nach Laptop-Test Standard.
- Start: `start.bat` = Desktop (Electron, einmaliger ~100-MB-Download), Fallback Browser; `start-browser.bat` = Browser. `npm ci` nur bei geändertem `package-lock.json`, vorher `npm ping`.

---

## 3. Zielhardware & Modelle (Nutzer-Laptop – von dir aus der Cloud NICHT testbar)

Windows; AMD Ryzen 7 5800H (8 Kerne); **15,9 GB RAM**; **NVIDIA RTX 3060 Laptop, 6 GB VRAM**; 198 GB frei auf C:. Ollama installiert (`127.0.0.1:11434`).
Vorhandene Modelle: `nomic-embed-text`, `gemma3:4b` (Vision), `qwen3:4b`, `qwen3:8b`, `llama3.1:8b`, `phi4-mini`, `granite3.3:8b`, `mistral:7b`, `llama3.2:3b`, `deepseek-r1:8b`, `gemma3:4b`, `qwen2.5-coder:7b`, `deepseek-coder:6.7b`, `nemotron-mini`.

**Defaults:** Chat/Vision `gemma3:4b` (passt komplett in 6 GB), „Denken“ `qwen3:4b`/`qwen3:8b` (8B läuft teils auf CPU), `num_ctx` 8192 (VRAM-Grenze beachten; Kontrolle `ollama ps` → „100 % GPU“).
Neuere Modelle (z. B. `qwen3.5:4b`, `gemma4`-Varianten) sind **nur aus Blogs belegt, nicht verifiziert** → vor jeder Empfehlung gegen die Ollama-Bibliothek prüfen; **nie automatisch pullen**; Pulls macht der Nutzer selbst (App zeigt kopierbaren Befehl).
**VRAM-Realität:** Chat-Modell, Embedding-Modell, Whisper und Vision teilen sich 6 GB. Hintergrundjobs dürfen den interaktiven Chat nicht verdrängen; Modelle bei Bedarf per `keep_alive` entladen. Alle GPU-lastigen Schritte **seriell** planen.

---

## 4. Architektur-Leitplanken (gelten in allen Phasen)

1. **Alles in einem Datenordner** (`%USERPROFILE%\Uni-Hotspot-Daten`, per `HOTSPOT_DATA_DIR`/Settings änderbar). Backup = Ordner kopieren. Neue Daten (Transkripte, Karteikarten, Graph, Medien-Tools/Modelle) gehören dorthin bzw. in den Projektordner, nie ins System. Große Werkzeuge (whisper.cpp, ffmpeg, Modelle) in `tools/` im Projektordner **oder** `<Datenordner>/tools/` (Entscheidung begründen; gitignored).
2. **Keine nativen npm-Module** zur Laufzeit, außer es gibt Windows-Prebuilds **und** eine messbare Begründung. Neue Dependencies klein, begründet, in der README-Tabelle dokumentiert. Externe Binaries (whisper.cpp, ffmpeg) nur als **Child-Process mit festen Argumenten (kein Shell-String)**, SHA-256-verifizierter Download **nach ausdrücklicher Nutzerbestätigung**, Installation nur in den Projekt-/Datenordner, vollständig reversibel (Ordner löschen).
3. **Server nur `127.0.0.1`**, Token-/Host-/Origin-Checks, parametrisiertes SQL, Path-Traversal-Schutz, Größen-/Zeit-/Anzahl-Limits, XSS-Schutz (DOMPurify; Dokument-, OCR-, Transkript- und Modelltext sind **nicht vertrauenswürdig**; Prompt-Injection: Fremdtext im Prompt immer als Daten abgrenzen). Electron-Härtung beibehalten.
4. **Erweiterbar statt umbauen:** neue Dateitypen = neue `Extractor` in `server/ingest/extractors/registry.ts`; Vektoren hinter `VectorStore`; Hintergrundarbeit über die bestehende persistente Queue-Idee (neustartfest, abbrechbar, fehlertolerant, Fortschritt per SSE).
5. **Persistente, neustartfeste Jobs:** reguläres Beenden reiht unterbrochene Jobs wieder ein; Absturz (kill -9) darf nie halbe/inkonsistente Daten hinterlassen (Chunks = FTS = Vektoren, `integrity_check` ok).
6. **Event-Loop schützen:** Schweres im Worker/Child-Process oder in Batches mit `setImmediate`; `node:sqlite` ist synchron – lange Queries/Transaktionen blockieren den ganzen Server (in Phase 1 mehrfach gemessen!).
7. **Kein Over-Engineering, kein Scope-Creep:** pro Phase nur der beschriebene Umfang. Jede Abweichung vom Auftrag begründen.
8. **i18n vollständig:** jeder Fehler als **Code** + Client-Übersetzung (DE/EN), Test „jeder Code hat DE+EN“ erweitern. Keine deutschen Server-Strings in der EN-Oberfläche.
9. **Design:** bestehendes dunkles Glas-/Neon-Design (Tokens als CSS-Variablen, Hell-Variante, `prefers-reduced-motion`, Tastatur/Fokus, Kontrast AA – es gibt einen Kontrast-Test). Neue Ansichten fügen sich nahtlos ein, bleiben performant.

---

## 5. Lektionen aus Phase 1 (nicht wiederholen)

- **Review-Fixes erzeugen Folgefehler:** Jeder Fix braucht einen Regressionstest, der auf dem **alten Code fehlschlägt**; Fix-Runden werden vom Kritiker erneut geprüft (so wurden 4 mittlere Folgefehler gefunden: stilles Beenden→„abgebrochen“, Timer nach `db.close()`, PID-Wiederverwendung der Sperrdatei, HTML ohne `</head>`).
- **Race Conditions:** Re-Index mitten im Embedding-Batch verfälschte den Index still (Vektorsuche → 0 Treffer). Bei allem, was Modelle/Dimensionen/Jobs wechselt: AbortController, Modell-Check nach jedem `await`, Dimension in `meta`.
- **Synchrone SQLite-Queries skalieren schlecht:** Eine Bibliotheksliste mit schlechtem Index brauchte 85 s und blockierte alles. Bei jeder neuen Abfrage `EXPLAIN QUERY PLAN` prüfen, mit 2000 Quellen / 40k+ Chunks messen.
- **Große/präparierte Eingaben:** ReDoS (verschachtelte Regex-Quantoren), Zip-Bomben, 195-MB-Text (RAM!), pathologisches Markdown (`*a ` × 13000 = 16 s im UI-Thread). Für jeden neuen Parser/Renderer: pathologische Eingaben + Zeitlimit-Tests.
- **Windows-spezifisch:** `.bat` = CRLF + ASCII, Pfade quoten, OneDrive/Umlaute/Dateisperren durch Virenscanner, PID-Wiederverwendung, `SIGINT`-Weiterleitung unter win32, PowerShell-Ausführungsrichtlinie (`npm.cmd`), SmartScreen/Smart App Control. Child-Prozesse unter Windows brauchen `taskkill /T /F`-artiges Beenden des Prozessbaums (kein Admin nötig).
- **Zweitstart/Sperrdatei:** zweite Instanz auf demselben Datenordner darf nichts beschädigen (bereits gelöst – Verhalten erhalten).
- **Flaky Tests:** zeitbasierte Assertions vermeiden (deterministisch zählen), Ports/Temp pro Testdatei isolieren; vor Abgabe `npm test` **mind. 30× hintereinander grün** (mit Log pro Lauf).
- **Playwright im Container:** Chromium ist vorinstalliert (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`), **nie `playwright install`**; ggf. `executablePath` auf `/opt/pw-browsers/chromium*`; lange Socket-Pfade im Scratchpad können Chromium am Start hindern (kurzen Pfad nutzen); Playwright kann in POSIX-Locale keine Umlaut-Dateinamen per Pfad setzen (Buffer nutzen).
- **Messwerte vorher/nachher** gehören in README (Abschnitt „Messwerte“) – Zahlen, keine Adjektive.

---

## 6. Gemeinsame Bedingungen für ALLE Phasen

**6.1 Phasen-Gate.** Nach jeder Phase: Schlussbericht + Screenshots (`docs/screenshots/`) + aktualisierte `README.md`/`HANDOFF.md` (neue Laptop-Checkliste für genau diese Phase) → **warte auf Zustimmung des Nutzers**, bevor die nächste Phase beginnt. Phase 2 startet erst, wenn der Nutzer Rückmeldung zum Laptop-Test von Phase 1 gegeben hat – **oder ausdrücklich „los“ sagt**. Fragt der Nutzer „soll ich schon anfangen?“: kurze Empfehlung geben, nicht eigenmächtig starten.

**6.2 Test-Pflicht je Phase:**
- vitest: Unit + Integration (Extractoren, Queue-Neustart, Löschkonsistenz, Sicherheitschecks, i18n-Codes, pathologische Eingaben). Alle Tests grün; **30× Schleife** grün; Typecheck + Lint sauber.
- Browser-E2E per Playwright (Chromium) für alle neuen Ansichten, Desktop + schmales Fenster (~600 px), Konsole ohne Fehler, Screenshots ansehen und bewerten.
- Mock-Erweiterungen (`server/ollama/mock.ts`, `scripts/mock-ollama.ts`; für Whisper/ffmpeg ein **Fake-Binary-Skript**), damit alles hier headless testbar ist. Mock-Modus klar von echtem Betrieb getrennt (`HOTSPOT_MOCK_OLLAMA=1`, UI zeigt „MOCK“).
- Kritiker prüft gegen Auftrag; Tester führt Praxisangriffe aus (Token/Host/Origin/Traversal/XSS/Injection, kill -9 mitten im Job, Löschen während der Verarbeitung, Ollama-/Tool-Ausfall, riesige/kaputte/verschlüsselte Dateien).
- **Windows und echtes Ollama sind hier nicht testbar** → jede Phase liefert eine konkrete Laptop-Checkliste im `HANDOFF.md` (Befehle, erwartete Ausgaben, VRAM-Check, „was melden“).

**6.3 Datenbank-Migrationen (kritisch ab Phase 2).** Phase 2/3 fügen Tabellen/Spalten hinzu. **Zuerst prüfen**, ob `server/db.ts` ein versioniertes Schema (`user_version` o. ä.) hat. Falls nicht: **Migrations-Gerüst als erster Schritt von Phase 2** (idempotent, transaktional, **automatisches Backup der DB vor Migration**, Test mit einer **Phase-1-DB als Fixture**). Nie das Nutzer-DB-Schema „neu erstellen“.

**6.4 Hintergrund-Scheduler.** Phase 2 und 3 erzeugen rechenintensive Jobs (OCR/Vision, Whisper, Karteikarten-/Graph-Generierung). Führe eine **einfache Prioritätslogik** ein, kein Framework: interaktiver Chat > Embedding > Medien > Lernmodus-Generierung; GPU-Jobs seriell; Hintergrundjobs pausieren während ein Chat streamt; Fortschritt/ETA/Abbrechen in der UI (Queue-Ansicht); Fehler pro Job sichtbar; neustartfest.

**6.5 Ehrlichkeit der KI-Ausgaben.** Alles KI-Generierte (Beschreibungen, Transkripte, Karten, Zusammenfassungen, Graph) ist **als KI-generiert markiert**, verweist auf die Quelle (Chunk/Seite/Zeitstempel) und ist bearbeitbar/löschbar. Kleine lokale Modelle (4B) machen Fehler: strukturierte Ausgabe (Ollama `format` mit JSON-Schema), Validierung, begrenzte Retries, Plausibilitätsprüfung gegen die Quelle; Qualität an realen Beispielen bewerten (Laptop-Test) statt zu behaupten.

---

## 7. PHASE 2 – Bilder, Audio, Video, gescannte PDFs („alles“ wird lesbar)

**Ziel:** Alles, was in Phase 1 nur gespeichert wurde, wird durchsuchbar, zitierbar und im Chat befragbar.

**7.1 Bilder (PNG/JPG/WebP/BMP/TIFF/GIF; HEIC nur wenn ohne native Module machbar, sonst „gespeichert“):**
- Extractor liefert (a) **Text im Bild** (OCR) und (b) **Beschreibung** (Vision, `gemma3:4b` über `/api/chat` mit `images`-Base64), beides als Chunks mit Metadaten („Bild“, ggf. Seite/Folie, falls eingebettet).
- **OCR-Entscheidung per Messung:** (1) Vision-Modell transkribiert Text, (2) `tesseract.js` (WASM, `deu+eng`-Traineddata im Projektordner, einmaliger bestätigter Download). Auf einer kleinen Testmenge (Foto Tafel, gescannte Seite, Screenshot, Handschrift) Qualität + Zeit vergleichen; schlankere Lösung als Standard, die andere optional. Ergebnis dokumentieren.
- Vorverarbeitung ohne native Module bevorzugen (Größenbegrenzung, ggf. Skalierung). Falls ein Rasterizer nötig ist (gescannte PDFs): Kandidaten bewerten (z. B. pdf.js + `@napi-rs/canvas`-Prebuild); nativer Prebuild nur mit Begründung.
- Eingebettete Bilder in PDF/PPTX/DOCX: **optional (Setting, standardmäßig aus)**, weil teuer.

**7.2 Gescannte PDFs:** Seiten ohne Textschicht (oder mit zu wenig Text) → Seite rastern → OCR/Vision. Pro Seite entscheiden, nicht pro Datei. Seitenzitate bleiben korrekt.

**7.3 Audio & Video:**
- **Transkription lokal mit whisper.cpp** (kein Python): Windows-Release-Binary (`whisper-cli.exe`) + ggml-Modell. Modellgröße per Messung auf dem Laptop (`small` vs. `medium`, ggf. quantisiert; Deutsch+Englisch, Sprache automatisch erkennen; GPU-Variante nur, wenn sie neben Ollama in 6 GB sinnvoll läuft, sonst CPU mit 8 Kernen). **Ergebnis der Messung entscheidet den Default.**
- **ffmpeg** (portable, nur Projekt-/Datenordner) zum Konvertieren auf 16-kHz-Mono-WAV und zum Ziehen der Tonspur aus Video. Kein globales Installieren.
- Lange Aufnahmen (Vorlesung 90–180 min): in **Segmenten** (z. B. 5–10 min mit kleiner Überlappung) verarbeiten, Fortschritt **persistent** (Neustart setzt beim letzten Segment fort), ETA anzeigen, abbrechbar (Prozessbaum sauber beenden).
- Transkript-Chunks mit **Zeitbereich** (`mm:ss–mm:ss`); Zitate im Chat/Suche zeigen die Zeit; im Quellen-Panel ein **Audio/Video-Player**, der per Klick auf das Zitat **an die Stelle springt**. Dafür muss die Datei-Route **HTTP-Range-Requests** unterstützen (prüfen, ob vorhanden; sonst ergänzen – mit Path-Traversal-/Token-Schutz). Sicherheit: Medien nur mit sicheren Content-Types/`nosniff`/Sandbox-CSP ausliefern.
- Video optional: Keyframes (z. B. alle N s oder bei Szenenwechsel, **begrenzte Anzahl**) → Vision-Beschreibung/OCR; **Setting, standardmäßig aus oder niedrig**, wegen Kosten.
- Kein Speaker-Diarization, keine Live-Aufnahme (nicht im Umfang).

**7.4 Tool-Setup (ohne Admin, reversibel):**
- `scripts/setup-media.mjs` (+ Button in Einstellungen mit Status): lädt whisper.cpp-Release, ffmpeg-Build, Whisper-Modell, ggf. Tesseract-Daten in den Projekt-/Datenordner, **SHA-256-Prüfung**, **nur nach ausdrücklicher Bestätigung** (Größen vorher anzeigen), nichts außerhalb. Quellen-URLs und Hashes in einer Manifest-Datei; Download-Fehler/Proxy verständlich melden; Neustart-/Teil-Download-fest. Ohne Tools bleibt alles wie in Phase 1 („gespeichert“, mit Hinweis was fehlt) – **kein Absturz, keine Pflicht**.
- Einstellungen: Abschnitt „Medien“ (Status je Tool, Modellwahl, Schalter je Typ: Bilder/Audio/Video/Scan-OCR/Keyframes, Sprache auto/de/en).

**7.5 Sicherheit/Robustheit:** Child-Prozesse mit festen Argumenten (kein Shell), Timeouts, Speicher-/Dauer-/Größenlimits (z. B. max. Dauer/Dateigröße konfigurierbar), Mediendatei-Sniffing (Endung ≠ Inhalt), keine Ausführung von Nutzerdateien, defekte/verschlüsselte/DRM-Medien → saubere Fehlercodes (DE/EN), Prompt-Injection aus OCR-/Transkripttext abgegrenzt, Löschen einer Quelle entfernt Chunks, Vektoren, Transkript-Zwischenstände und Temp-Dateien konsistent.

**7.6 Akzeptanzkriterien Phase 2:** Foto/Scan/Screenshot → Text+Beschreibung durchsuchbar; gescanntes PDF seitengenau durchsuchbar; MP3/WAV/M4A/MP4/MKV → Transkript mit Zeit, Zitat springt im Player; lange Datei neustartfest; Chat läuft während Hintergrundverarbeitung weiter (Priorität); fehlende Tools → klare Anleitung statt Fehler; alle Tests/Lint/Typecheck grün (30×); Migration von einer Phase-1-DB getestet; README/HANDOFF/Screenshots aktualisiert; Laptop-Checkliste (echtes Whisper/ffmpeg/Vision, VRAM, Dauer pro Audio-Minute, OCR-Qualität deutsch/englisch).

---

## 8. PHASE 3 – Lernmodi

**Ziel:** Aus dem Material wird ein Lernsystem. Alles quellengebunden, bearbeitbar, lokal.

**8.1 Zusammenfassungen/Notizen:** pro Quelle, Kapitel/Abschnitt, Fach oder Chat-Verlauf; Stufen *TL;DR / Gliederung / ausführlich / Klausur-Spickzettel*; **Map-Reduce** über Chunks (Kontext nur 8k!), Zwischenergebnisse cachen (Invalidierung bei geänderter Quelle), Ergebnis als **Markdown-Notiz** speichern (editierbar, mit Quellenverweisen), Export nach Markdown. Lange Läufe als Hintergrundjob mit Fortschritt.

**8.2 Karteikarten + Spaced Repetition:**
- Generierung aus Quelle/Abschnitt/Auswahl/Chat; strukturierte Ausgabe (JSON-Schema), Validierung, Dedupe (Embedding-Ähnlichkeit), jede Karte **mit Quellenverweis**; **Entwurfs-Status**: Nutzer sieht Vorschläge, nimmt an/bearbeitet/verwirft (nichts landet ungeprüft im Stapel). Manuelle Karten möglich.
- Wiederholungs-Algorithmus: bewährt und klein (FSRS-Variante oder SM-2; **Begründung + Test mit bekannten Referenzwerten**; wenn eine winzige, rein-JS-Lib existiert, prüfen, sonst selbst implementieren). Tägliche Fällig-Liste, Bewertung per Tastatur (1–4), Statistiken (Heatmap, Fälligkeitsprognose, Trefferquote), pro Fach filterbar, Kartentypen: Frage/Antwort, Lückentext (Cloze), Bild (aus Phase 2).
- Daten gehören in die DB (versioniert, Migration!), Review-Verlauf bleibt bei Edit erhalten.

**8.3 Quiz/Klausurfragen:** Multiple Choice, Wahr/Falsch, Lückentext, Kurzantwort; Modi: Fach/Quelle/Auswahl, **Klausursimulation mit Timer**; Freitext-Antworten durch das Modell **gegen die Quellen bewerten** (Rubrik, Begründung, Zitate), korrekte Lösung immer mit Quelle; Verlauf + **Schwächen-Analyse** (welche Themen oft falsch) → Vorschlag „diese Karten/Abschnitte wiederholen“. Fragenpool cachen, Duplikate vermeiden.

**8.4 Wissensgraph:** Konzepte + Beziehungen pro Quelle extrahieren (strukturierte Ausgabe, gecacht, Hintergrundjob), **Duplikate zusammenführen** (Embedding-Ähnlichkeit + Namensnormalisierung), interaktive Graph-Ansicht (Zoom/Pan, Filter nach Fach/Quelle, Klick → Quellen/Chunks, „Frag dazu“ springt in einen Chat mit vorbelegtem Kontext), flüssig bis ~2 000 Knoten (Canvas/WebGL; leichte Lib wie `d3-force` oder eigene Force-Simulation – **per Messung begründen**), `prefers-reduced-motion` respektieren, **barrierefreie Alternativansicht (Liste/Tabelle)**. Kein Zwang zur Vollständigkeit: Qualität > Menge; Nutzer kann Knoten/Kanten ausblenden/korrigieren.

**8.5 Querschnitt Phase 3:** Priorität/GPU-Seriell aus 6.4; Generierung nie auf Kosten des Chats; Qualitätsmessung der Generierung mit kleinem **Eval-Skript** (reale Testdokumente, Ausgabe für manuelle Bewertung durch den Nutzer – keine erfundenen Qualitätszahlen); alles mit „KI-generiert“-Kennzeichnung; Löschen einer Quelle bereinigt abgeleitete Objekte konsistent (Karten behalten ggf. Text, verlieren aber den Quellenlink mit Hinweis – Verhalten festlegen und testen).

**8.6 Akzeptanzkriterien Phase 3:** Zusammenfassung langer Quelle (> Kontext) funktioniert und zitiert; Karten generieren → prüfen → lernen → SRS-Zeitplan korrekt (Tests); Quiz inkl. Freitextbewertung mit Quellen; Graph baut sich im Hintergrund, bleibt flüssig, Alternativansicht vorhanden; Neustart-/Crash-Festigkeit; Migration von Phase-2-DB getestet; Tests (30×)/Lint/Typecheck/E2E grün; Laptop-Checkliste (Qualität auf echten Unterlagen, Dauer, VRAM-Verhalten während Generierung + Chat).

---

## 9. PHASE 4 – Installer, Backup, Politur

**9.1 Distribution (ohne Admin):** Windows-Paket als **portable Ordner/ZIP und/oder per-user-Installer** (z. B. electron-builder, `perMachine: false`, kein UAC). Da hier kein Windows verfügbar ist: **Bauen per GitHub-Actions-Workflow auf `windows-latest`** (Workflow-Datei im Repo, Artefakt-Download) **oder** per Skript auf dem Laptop – Entscheidung begründen. Ohne Codesignatur → SmartScreen-Warnung dokumentieren (Signatur ist nicht im Umfang). Der Installer enthält **keine** Modelle/Whisper/ffmpeg (bleiben bestätigter Download wie in Phase 2). Update = manuell neue Version drüberinstallieren/entpacken; **Datenordner bleibt unberührt, DB-Migration mit Auto-Backup**.

**9.2 Backup/Restore/Export:** Automatische Snapshots des Datenordners (SQLite-konsistent über `VACUUM INTO`/Backup-API, nicht Rohkopie bei laufendem WAL), Zielordner wählbar, Aufbewahrung N, Wiederherstellen-Funktion mit Bestätigung (vorher Sicherung des Ist-Zustands), Export/Import einer kompletten Bibliothek oder eines Fachs; Export von Notizen/Zusammenfassungen (Markdown, PDF via Electron `printToPDF`), Karteikarten-Export (CSV; Anki-Format nur wenn klein und sauber machbar – sonst weglassen).

**9.3 Erststart-Assistent:** prüft Ollama + Modelle (kopierbare Befehle), Datenordner, optional Medien-Tools; legt erstes Fach an; erklärt Kernfunktionen kurz. Kein Zwang, jederzeit überspringbar.

**9.4 Performance/Robustheit:** Startzeit und RAM messen/verbessern; Listen virtualisieren, wo > 2 000 Einträge realistisch sind (Bibliothek: aktuell Kappung „2000 von N“ – ggf. Paginierung/Virtualisierung); Hybrid-Suche bei ≥ 100k Chunks messen – **nur bei Überschreiten der Schwelle** ANN/anderes Backend hinter `VectorStore` erwägen (LanceDB neu bewerten, Messung + Windows-Größe); Diagnose-Seite (Versionen, Ollama-Status, Tool-Status, Log-Export **ohne Inhalte der Nutzerdokumente**); Abstürze/Fehler nutzerfreundlich; Log-Rotation.

**9.5 Politur:** i18n-Vollständigkeit (Test), Barrierefreiheits-Audit (Tastatur, Fokus, Kontrast, Screenreader-Labels), Design-Feinschliff (konsistente Abstände/Animationen, Leerzustände, Fehlerzustände), README/Anleitung final (Deutsch), Roadmap/Bekannte Grenzen aktualisieren.

**9.6 Akzeptanzkriterien Phase 4:** reproduzierbares Windows-Paket (per CI-Artefakt oder dokumentiertem Build), startet ohne Admin; Backup→Restore-Roundtrip getestet; Migration von Phase-1/2/3-DB getestet; Erststart-Assistent; Perf-Zahlen vorher/nachher; Audit-Ergebnisse; alle Tests (30×), Lint, Typecheck, E2E grün; finale Laptop-Checkliste.

---

## 10. Offene Entscheidungen (Standard = Empfehlung; im Zweifel kurz den Nutzer fragen, nicht raten)

| Thema | Empfehlung |
|---|---|
| OCR-Weg | per Messung entscheiden (Vision-Modell vs. tesseract.js); Vision-Modell zuerst, weil keine neue Dependency |
| Whisper-Größe/GPU | per Laptop-Messung (`small`/`medium`, CPU vs. GPU); Default = schnellste Variante mit akzeptabler Qualität, nie GPU-Konflikt mit Ollama |
| Embedding-Standard | `nomic-embed-text` bleibt, `bge-m3` erst nach `ollama ps`-Test (gemma3:4b @8k + bge-m3 beide 100 % GPU?) |
| SRS-Algorithmus | FSRS-Variante oder SM-2; schlanker, getestet |
| Graph-Rendering | Canvas + `d3-force` (oder eigene Simulation) – messen |
| Distribution | GitHub-Actions-Build (Windows-Runner) + portable ZIP, per-user-Installer optional |
| Anki-Export | nur wenn klein; sonst CSV |

**Nicht im Umfang (nur mit ausdrücklichem Okay):** Cloud-KI-Fallback, Live-Aufnahme, Speaker-Diarization, Kalender/Lernplan, Mobile-App, Mehrbenutzer/Sync, Code-Signing, Auto-Updater.

---

## 11. Was du JETZT tust (Schritt 1)

1. Repo lesen: `README.md`, `HANDOFF.md`, `server/db.ts`, `server/ingest/extractors/registry.ts`, `server/ingest/ingest.ts`, `server/http/routes.ts` (Datei-Route/Range?), `server/ollama/client.ts`, `tests/helpers.ts`. Branch/Stand prüfen (`git log`), `npm ci && npm test` einmal laufen lassen (Baseline: 148 Tests grün).
2. **Dem Nutzer in max. 10 Zeilen** bestätigen: Stand verstanden, Phasenablauf, und die **Fragen**, die vor Phase 2 wirklich nötig sind (z. B.: Gibt es Rückmeldung zum Laptop-Test von Phase 1? Erlaubnis für die Tool-Downloads whisper.cpp/ffmpeg/Modelle in den Projektordner? Typische Medien: Länge der Vorlesungsaufnahmen, Foto- vs. Scan-Anteil?). Nicht mehr fragen als nötig.
3. Erst nach Antwort/„los“: Phase 2 nach dem Ablauf aus Abschnitt 0 starten (Auftrags-Prompt → Dev → Kritiker+Tester parallel → Korrekturrunden → Schlussbericht → Gate).

## 12. Format des Schlussberichts je Phase (max. ~25 Zeilen, Deutsch)

Was gebaut · Was getestet (Zahlen: Tests, 30×-Schleife, E2E, Messwerte vorher/nachher) · Gefundene/behobene Befunde (Kurzliste) · **Nur auf dem Laptop prüfbar** (mit Verweis auf Checkliste) · Offene Punkte · **Was die Zustimmung des Nutzers braucht** · Link/Pfad zu Screenshots und aktualisierter `HANDOFF.md`.
