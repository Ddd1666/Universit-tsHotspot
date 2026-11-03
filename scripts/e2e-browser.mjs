// Browser-End-to-End-Check (Playwright/Chromium) gegen den Mock-Modus.
//   node scripts/e2e-browser.mjs [Screenshot-Ordner]
// Benötigt eine Playwright-Installation (nicht Teil der App-Abhängigkeiten):
//   PLAYWRIGHT_MODULE=<pfad/zu/playwright/index.mjs>  CHROMIUM_PATH=<pfad/zu/chrome>
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ensureWebBuild, NODE_FLAGS, ROOT } from './lib.mjs';

const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, '.tmp', 'e2e', 'screens'));
const PW = process.env.PLAYWRIGHT_MODULE ?? '/opt/node22/lib/node_modules/playwright/index.mjs';
const CHROME = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = Number(process.env.E2E_PORT ?? 4391);
const DATA = path.join(ROOT, '.tmp', 'e2e', `data-${Date.now()}`);
const FILES = path.join(ROOT, '.tmp', 'e2e', 'files');

// absolute Pfade unter Windows nur als file://-URL importierbar
const { chromium } = await import(path.isAbsolute(PW) ? pathToFileURL(PW).href : PW);
const fx = await import('../tests/fixtures.ts');
ensureWebBuild();
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(FILES, { recursive: true });

// --- Testdateien erzeugen
const files = {
  'Thermodynamik-Skript.pdf': fx.makePdf([
    ['Kapitel 1: Thermodynamik', '', 'Der erste Hauptsatz beschreibt die Energieerhaltung in geschlossenen Systemen.'],
    ['Kapitel 2: Entropie', '', 'Der zweite Hauptsatz besagt, dass die Entropie eines abgeschlossenen Systems nie abnimmt.', 'Entropie ist ein Maß für die Anzahl möglicher Mikrozustände.'],
  ]),
  'Hausarbeit-Waermelehre.docx': fx.makeDocx([
    { text: 'Wärmelehre', style: 'Heading1' },
    { text: 'Die Carnot-Maschine ist ein idealisierter Kreisprozess mit maximalem Wirkungsgrad.' },
  ]),
  'Vorlesung-03.pptx': fx.makePptx([
    { title: 'Kreisprozesse', body: ['Carnot-Prozess', 'Stirling-Prozess'], notes: 'Wirkungsgrad an der Tafel herleiten.' },
    { title: 'Zusammenfassung', body: ['Entropie steigt bei irreversiblen Prozessen'] },
  ]),
  'Messwerte.xlsx': fx.makeXlsx([{ name: 'Versuch 1', rows: [['Temperatur', 'Druck'], [293, 1.01], [313, 1.08]] }]),
  'Uebungsblatt.zip': fx.makeZip({ 'blatt1/aufgabe1.md': '# Aufgabe 1\n\nBerechne die Entropieänderung beim isothermen Prozess.', 'blatt1/notizen.txt': 'Formel: dS = dQ / T' }),
  // Phase 2: echtes PNG (Mock-OCR liest den Marker), abspielbare WAV-Aufnahme (Fake-Whisper), Scan-PDF
  'Tafelbild.png': fx.makePng(96, 64, 'Tafelbild: Entropie S = k ln W'),
  'Vorlesung-Thermo.wav': playableWav(1500, { duration: 1500, words: Array.from({ length: 50 }, (_, i) => (i === 40 ? 'Wärmekraftmaschine' : 'Wiederholung')) }),
  'Scan-Kapitel3.pdf': fx.makeScanPdf([{ lines: ['Kapitel 3: Kreisprozesse – Einleitung mit ausreichend Text auf dieser Seite.'] }, { image: { w: 320, h: 400 } }]),
};
for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(FILES, name), data);
// hängende Aufnahme für die Aufgaben-Ansicht (läuft, bis sie abgebrochen wird)
const HANG = path.join(FILES, 'hang.flag');
fs.writeFileSync(HANG, '1');
fs.writeFileSync(path.join(FILES, 'Lange-Vorlesung.mp3'), fx.makeFakeMedia('mp3', { duration: 5400, hangFile: HANG, hangFrom: 1100 }));

/** Abspielbares WAV (8 kHz, 8 Bit, Stille) + Steuer-Marker für das Fake-ffmpeg hinter den Audiodaten. */
function playableWav(seconds, spec) {
  const n = seconds * 8000;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + n, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(8000, 28);
  h.writeUInt16LE(1, 32);
  h.writeUInt16LE(8, 34);
  h.write('data', 36);
  h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.alloc(n, 128), Buffer.from(`\nFAKEMEDIA${JSON.stringify({ audio: true, ...spec })}\n`, 'latin1')]);
}

// Fake-Werkzeuge (nur Mock-Modus): whisper/ffmpeg als Node-Skripte, Modell-Attrappe
const MODELS = path.join(ROOT, '.tmp', 'e2e', 'models');
fs.mkdirSync(MODELS, { recursive: true });
fs.writeFileSync(path.join(MODELS, 'ggml-small.bin'), 'fake');
const MEDIA_TOOLS = JSON.stringify({
  ffmpeg: [process.execPath, path.join(ROOT, 'tests', 'fake-tools', 'ffmpeg.mjs')],
  whisper: [process.execPath, path.join(ROOT, 'tests', 'fake-tools', 'whisper-cli.mjs')],
  modelsDir: MODELS,
});
const uploadNames = Object.keys(files);

// Phase 3: großer Wissensgraph (2000 Konzepte) direkt in die DB – misst, ob die Ansicht flüssig bleibt
const GRAPH_NODES = 2000;
{
  const { openDb } = await import('../server/db.ts');
  fs.mkdirSync(DATA, { recursive: true });
  const db = openDb(path.join(DATA, 'hotspot.sqlite'));
  db.exec('BEGIN');
  const sub = Number(db.prepare("INSERT INTO subjects(name, color, created_at) VALUES ('Graph-Last', '#ff5fd9', 1)").run().lastInsertRowid);
  const src = Number(
    db.prepare("INSERT INTO sources(subject_id, sha256, name, size, mime, kind, status, imported_at) VALUES (?, ?, 'Graph-Last.txt', 1, 'text/plain', 'text', 'ready', 1)").run(sub, 'f'.repeat(64)).lastInsertRowid,
  );
  const ins = db.prepare('INSERT INTO concepts(name, norm, created_at) VALUES (?, ?, 1)');
  const link = db.prepare('INSERT INTO concept_sources(concept_id, source_id) VALUES (?, ?)');
  const edge = db.prepare("INSERT OR IGNORE INTO concept_edges(a, b, label, source_id) VALUES (?, ?, 'verbunden', ?)");
  const ids = [];
  for (let i = 0; i < GRAPH_NODES; i++) {
    const id = Number(ins.run(`Konzept ${i}`, `konzept ${i}`).lastInsertRowid);
    link.run(id, src);
    ids.push(id);
  }
  for (let i = 1; i < GRAPH_NODES; i++) edge.run(ids[Math.floor((i - 1) / 3)], ids[i], src);
  for (let i = 0; i < GRAPH_NODES / 2; i++) edge.run(ids[(i * 7) % GRAPH_NODES], ids[(i * 13 + 5) % GRAPH_NODES], src);
  db.exec('COMMIT');
  db.close();
}

// --- Server starten (Mock-Ollama)
const server = spawn(process.execPath, [...NODE_FLAGS, path.join(ROOT, 'server', 'main.ts')], {
  cwd: ROOT,
  env: { ...process.env, HOTSPOT_MOCK_OLLAMA: '1', HOTSPOT_PORT: String(PORT), HOTSPOT_DATA_DIR: DATA, HOTSPOT_MEDIA_TOOLS_JSON: MEDIA_TOOLS },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const url = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(url + '/')).ok) break;
  } catch {
    /* noch nicht bereit */
  }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch(fs.existsSync(CHROME) ? { executablePath: CHROME } : {});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
/** bewusst ausgelöste Fehlerantworten (z. B. Validierung) – je Eintrag wird genau eine Konsolenmeldung toleriert */
const expectedConsole = [];
/** Neustart nach Wiederherstellung: Server ist kurz weg -> abgewiesene Verbindungen sind dann erwartet */
let allowNetErrors = false;
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (allowNetErrors && /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|401|Failed to load resource/.test(m.text())) return;
  errors.push('console: ' + m.text());
});
// Barrierefreiheit: Bedienelemente ohne zugänglichen Namen (Accessibility-Baum von Chromium, wie ihn Screenreader sehen)
const cdp = await context.newCDPSession(page);
const a11yIssues = [];
const NAMED_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'tab', 'switch', 'slider', 'spinbutton', 'menuitem']);
const audit = async (label) => {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  let checked = 0;
  for (const n of nodes) {
    if (n.ignored || !NAMED_ROLES.has(n.role?.value)) continue;
    checked++;
    if (!String(n.name?.value ?? '').trim()) a11yIssues.push(`${label}: ${n.role.value} ohne Namen`);
  }
  return checked;
};
const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`OK   ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message.split('\n')[0]}`);
    await page.screenshot({ path: path.join(OUT, `FAIL-${name.replace(/\W+/g, '_')}.png`) }).catch(() => {});
  }
};
const shot = async (name) => {
  // Hinweis-Toasts nicht in die Doku-Screenshots
  for (const b of await page.locator('.toast button').all()) await b.click().catch(() => {});
  await page.waitForTimeout(450); // Einblend-Animationen abwarten
  await page.screenshot({ path: path.join(OUT, name) });
};

try {
  await step('App lädt, Erststart-Assistent: Ollama/Modelle, Datenordner, Werkzeuge, erstes Fach, Tastatur', async () => {
    await page.goto(url);
    const wiz = page.locator('.wizard');
    await wiz.waitFor();
    results.push(`INFO Start bis bedienbar (Chromium, Mock): ${Math.round(await page.evaluate(() => performance.now()))} ms`);
    await audit('Assistent');
    await shot('phase4-assistent.png');
    await wiz.getByRole('button', { name: 'Weiter' }).click();
    await wiz.locator('.wiz-checks li').first().waitFor();
    const txt = await wiz.innerText();
    if (!txt.includes('Ollama läuft') || !txt.includes('installiert')) throw new Error('Ollama-Prüfung fehlt: ' + txt.slice(0, 200));
    // Fokusfalle: Tab bleibt im Dialog
    for (let i = 0; i < 14; i++) await page.keyboard.press('Tab');
    if (!(await page.evaluate(() => !!document.activeElement?.closest('.wizard')))) throw new Error('Fokus verlässt den Assistenten');
    await shot('phase4-assistent-ollama.png');
    await wiz.getByRole('button', { name: 'Weiter' }).click();
    await wiz.getByText('beschreibbar', { exact: true }).waitFor();
    await wiz.getByRole('button', { name: 'Weiter' }).click();
    await wiz.getByText('ffmpeg', { exact: true }).waitFor();
    await wiz.getByRole('button', { name: 'Weiter' }).click();
    await wiz.getByLabel('Name des Fachs').fill('Mathe');
    await wiz.getByRole('button', { name: 'Fach anlegen' }).click();
    await wiz.getByText('Fach „Mathe“ angelegt').waitFor();
    await shot('phase4-assistent-fertig.png');
    await wiz.getByRole('button', { name: 'Los geht’s' }).click();
    await wiz.waitFor({ state: 'detached' });
    await page.locator('.library-view').waitFor();
    await page.goto(url + '/#/chat');
    await page.getByRole('link', { name: 'Bibliothek' }).waitFor();
    await shot('01-start-chat-de.png');
  });

  await step('Fach anlegen', async () => {
    await page.getByRole('link', { name: 'Bibliothek' }).click();
    await page.getByRole('button', { name: 'Fach anlegen' }).first().click();
    await page.getByPlaceholder('Name des Fachs').fill('Physik');
    await page.getByRole('button', { name: 'Speichern' }).click();
    await page.locator('.subject-item', { hasText: 'Physik' }).waitFor();
  });

  await step('Import mehrerer Formate inkl. ZIP (Dateidialog)', async () => {
    await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(uploadNames.map((n) => path.join(FILES, n)));
    await page.locator('.import-panel').waitFor();
    await page.waitForFunction((n) => {
      const states = [...document.querySelectorAll('.import-state')].map((e) => e.textContent ?? '');
      return states.length === n && states.every((s) => /indexiert|Archiv entpackt|nur gespeichert/.test(s));
    }, uploadNames.length, { timeout: 60_000 });
    await page.locator('.source-row', { hasText: 'aufgabe1.md' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.source-row').length >= 10, null, { timeout: 15_000 });
    await page.waitForTimeout(2800); // Vektor-Fortschritt, Import-Liste klappt ein
    await shot('02-bibliothek-import.png');
  });

  await step('Quellen-Vorschau', async () => {
    await page.locator('.source-row', { hasText: 'Thermodynamik-Skript.pdf' }).locator('.source-main').click();
    await page.locator('.drawer .chunk-list li').first().waitFor();
    if (!/S\. \d/.test(await page.locator('.drawer').innerText())) throw new Error('Seitenangabe fehlt');
    await shot('03-quellen-vorschau.png');
    await page.locator('.drawer').getByRole('button', { name: 'Schließen' }).click();
  });

  await step('Phase 2: Bild -> OCR + Beschreibung, KI-gekennzeichnet', async () => {
    await page.locator('.source-row', { hasText: 'Tafelbild.png' }).locator('.source-main').click();
    await page.locator('.drawer .chunk-list li.ai .badge.ai').first().waitFor();
    const txt = await page.locator('.drawer').innerText();
    if (!txt.includes('Entropie S = k ln W') || !txt.includes('KI-generiert')) throw new Error('OCR/KI-Kennzeichnung fehlt');
    await shot('13-bild-ki.png');
    await page.locator('.drawer').getByRole('button', { name: 'Schließen' }).click();
  });

  await step('Phase 2: gescanntes PDF seitengenau durchsuchbar', async () => {
    await page.getByRole('link', { name: 'Suche' }).click();
    await page.getByPlaceholder('Begriff, Frage oder Stichwort …').fill('Mock-OCR 320x400');
    await page.locator('.result').first().waitFor();
    const first = await page.locator('.result').first().innerText();
    if (!first.includes('Scan-Kapitel3.pdf') || !first.includes('S. 2') || !first.includes('KI-generiert')) throw new Error('Scan-Treffer unerwartet: ' + first);
    await shot('14-suche-scan.png');
  });

  await step('Phase 2: Transkript-Zitat springt im Player an die Stelle', async () => {
    await page.getByRole('button', { name: 'Neuer Chat' }).click();
    const box = page.getByRole('textbox', { name: /Frag deine Unterlagen/ });
    await box.fill('Was wurde in der Vorlesung zur Wärmekraftmaschine gesagt?');
    await box.press('Enter');
    await page.locator('.msg.assistant:not(.is-streaming) .md button.cite').first().waitFor({ timeout: 20_000 });
    // Zitat-Chip der Aufnahme anklicken (Chips zeigen Quelle + Zeitbereich)
    await page.locator('.msg.assistant .cite-chip', { hasText: 'Vorlesung-Thermo.wav' }).first().click();
    await page.locator('.sources-panel .player-box audio').waitFor();
    const card = await page.locator('.sources-panel .cite-card.active').innerText();
    const m = /(\d\d):(\d\d)–/.exec(card);
    if (!m || !card.includes('Vorlesung-Thermo.wav')) throw new Error('aktives Zitat ohne Zeit: ' + card.slice(0, 120));
    const want = Number(m[1]) * 60 + Number(m[2]);
    await page.waitForFunction((w) => {
      const a = document.querySelector('.sources-panel .player-box audio');
      return a && a.readyState >= 1 && Math.abs(a.currentTime - w) < 3;
    }, want, { timeout: 10_000 });
    await page.locator('.sources-panel .player-box audio').evaluate((a) => a.pause());
    await shot('15-chat-transkript-player.png');
    await page.locator('.sources-panel').getByRole('button', { name: 'Schließen' }).click();
    // Chat wieder entfernen (spätere Schritte zählen Chats)
    const item = page.locator('.chat-item.active');
    await item.hover();
    await item.getByRole('button', { name: /Löschen/ }).click();
    await page.locator('.dialog').getByRole('button', { name: 'Löschen' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.chat-item').length === 0);
  });

  await step('Phase 2: Aufgaben-Ansicht mit Fortschritt/ETA, Abbrechen', async () => {
    await page.getByRole('link', { name: 'Bibliothek' }).click();
    await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(path.join(FILES, 'Lange-Vorlesung.mp3'));
    await page.getByRole('link', { name: 'Aufgaben' }).click();
    await page.locator('.job.running', { hasText: 'Lange-Vorlesung.mp3' }).locator('.mini-bar').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => /noch ~/.test(document.querySelector('.job.running')?.textContent ?? ''), null, { timeout: 15_000 });
    await shot('16-aufgaben.png');
    await page.locator('.job.running').getByRole('button', { name: 'Abbrechen' }).click();
    await page.locator('.job.cancelled', { hasText: 'Lange-Vorlesung.mp3' }).waitFor({ timeout: 10_000 });
  });

  await step('Phase 2: Einstellungen – Medien', async () => {
    await page.getByRole('link', { name: 'Einstellungen' }).click();
    const sec = page.locator('section[aria-labelledby=media-settings]');
    await sec.waitFor();
    await sec.scrollIntoViewIfNeeded();
    const secText = await sec.innerText();
    if (!secText.includes('installiert')) throw new Error('Werkzeug-Status fehlt');
    // T7: Hinweistexte nicht zusammengeklebt
    if (/Ollama\.Alternativ|nach\):node/.test(secText)) throw new Error('Hinweistexte ohne Abstand');
    // K11: Audio-Datei direkt geöffnet darf abspielen (media-src in der Sandbox-CSP)
    const csp = await page.evaluate(async () => {
      const t = document.querySelector('meta[name=hotspot-token]').content;
      const list = await (await fetch('/api/sources?q=Vorlesung-Thermo', { headers: { 'x-hotspot-token': t } })).json();
      const r = await fetch(`/api/sources/${list.items[0].id}/file?t=${t}`, { headers: { range: 'bytes=0-15' } });
      return r.headers.get('content-security-policy');
    });
    if (!/media-src 'self'/.test(csp ?? '')) throw new Error('media-src fehlt: ' + csp);
    await page.waitForTimeout(300);
    await sec.screenshot({ path: path.join(OUT, '17-einstellungen-medien.png') });
  });

  // ------------------------------------------------------------------ Phase 3: Lernmodi
  const api = (method, p, body) =>
    page.evaluate(
      async ([method, p, body]) => {
        const t = document.querySelector('meta[name=hotspot-token]').content;
        const r = await fetch(p, { method, headers: { 'x-hotspot-token': t, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return r.json();
      },
      [method, p, body],
    );
  const waitJobs = () =>
    page.waitForFunction(
      async () => {
        const t = document.querySelector('meta[name=hotspot-token]').content;
        const r = await (await fetch('/api/learn/jobs', { headers: { 'x-hotspot-token': t } })).json();
        return r.jobs.length > 0 && r.jobs.every((j) => j.state === 'done' || j.state === 'error' || j.state === 'cancelled');
      },
      null,
      { timeout: 60_000, polling: 300 },
    );
  const physik = async () => (await api('GET', '/api/subjects')).find((s) => s.name === 'Physik').id;

  await step('Phase 3: Zusammenfassung aus der Bibliothek → Notiz mit Quellen, KI-gekennzeichnet, Export', async () => {
    await page.getByRole('link', { name: 'Bibliothek' }).click();
    await page.locator('.source-row', { hasText: 'Thermodynamik-Skript.pdf' }).locator('.source-main').click();
    await page.locator('.drawer').getByRole('button', { name: 'Lernen' }).click();
    const dlg = page.locator('.gen-dialog');
    await dlg.waitFor();
    await dlg.getByRole('radio', { name: 'Zusammenfassung' }).click();
    await dlg.locator('label', { hasText: 'Stufe' }).locator('select').selectOption('detailed');
    await dlg.getByRole('button', { name: 'Starten' }).click();
    await page.locator('.toast', { hasText: 'Auftrag gestartet' }).waitFor();
    await waitJobs();
    await page.goto(url + '/#/learn/notes');
    await page.locator('.note-item').first().click();
    await page.locator('.note-body button.cite').first().waitFor();
    const txt = await page.locator('.note-view').innerText();
    if (!txt.includes('KI-generiert') || !txt.includes('Thermodynamik-Skript.pdf')) throw new Error('Notiz ohne KI-Kennzeichnung/Quelle');
    await page.locator('.note-body button.cite').first().click();
    await shot('phase3-notiz.png');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Markdown exportieren' }).click()]);
    if (!/\.md$/.test(dl.suggestedFilename())) throw new Error('Export-Dateiname: ' + dl.suggestedFilename());
  });

  await step('Phase 3: Karten erzeugen → Entwürfe prüfen/annehmen → Wiederholen per Tastatur (Leertaste, 1–4)', async () => {
    await page.goto(url + '/#/learn/cards');
    await page.getByRole('button', { name: 'Erzeugen' }).click();
    const dlg = page.locator('.gen-dialog');
    await dlg.getByRole('radio', { name: 'Karteikarten' }).click();
    await dlg.getByRole('radio', { name: 'Fach' }).click();
    await dlg.locator('label', { hasText: 'Fach' }).locator('select').selectOption({ label: 'Physik' });
    await dlg.getByRole('button', { name: 'Starten' }).click();
    await waitJobs();
    await page.locator('.card-row').first().waitFor({ timeout: 10_000 });
    if (!(await page.locator('.card-row .badge.ai').count())) throw new Error('Entwürfe ohne KI-Kennzeichnung');
    await shot('phase3-karten-entwuerfe.png');
    // eine Karte bearbeiten (Verlauf/Zeitplan bleiben), dann alle annehmen
    // Lückentext ohne {{…}} wird abgelehnt (Fehlermeldung), Frage/Antwort-Karte lässt sich bearbeiten
    await page.locator('.card-row', { hasText: 'Lückentext' }).first().getByRole('button', { name: 'Bearbeiten' }).click();
    await page.locator('.card-editor textarea').first().fill('ohne Lücke');
    await page.locator('.card-editor').getByRole('button', { name: 'Speichern' }).click();
    await page.locator('.toast', { hasText: 'Lücke' }).waitFor();
    await page.locator('.card-editor').getByRole('button', { name: 'Abbrechen' }).click();
    expectedConsole.push('400 (Bad Request)');
    await page.locator('.card-row', { hasText: 'Frage/Antwort' }).first().getByRole('button', { name: 'Bearbeiten' }).click();
    await page.locator('.card-editor textarea').first().fill('Was besagt der zweite Hauptsatz? (bearbeitet)');
    await page.locator('.card-editor').getByRole('button', { name: 'Speichern' }).click();
    await page.locator('.card-row', { hasText: '(bearbeitet)' }).waitFor();
    await page.getByLabel('Alle auswählen').check();
    await page.getByRole('button', { name: 'Ausgewählte annehmen' }).click();
    await page.locator('.card-row').first().waitFor({ state: 'detached' });
    await page.getByRole('tab', { name: 'Wiederholen' }).click();
    await page.locator('.review-card').waitFor();
    await page.keyboard.press('Space');
    await page.locator('.rating').waitFor();
    await shot('phase3-wiederholen.png');
    const before = await page.locator('.chip', { hasText: ' von ' }).innerText();
    await page.keyboard.press('3');
    await page.waitForFunction((b) => document.querySelector('.review .chip-row')?.textContent?.includes(b) === false, before.trim());
    await page.keyboard.press('Space');
    await page.keyboard.press('1'); // "Nochmal": kommt in dieser Sitzung erneut
    const st = await api('GET', '/api/srs/stats');
    if (st.retention.total !== 2) throw new Error('Bewertungen nicht gespeichert: ' + JSON.stringify(st.retention));
  });

  await step('Phase 3: Quiz üben – MC/Wahr-Falsch/Lücke/Freitext, Lösung mit Quelle, Freitext mit Rubrik', async () => {
    await api('POST', '/api/learn/jobs', { kind: 'quiz', scope: { kind: 'subject', id: await physik() }, count: 12 });
    await waitJobs();
    await page.getByRole('tab', { name: 'Quiz' }).click();
    await page.locator('.quiz-setup', { hasText: 'Fragen im Pool' }).waitFor();
    await page.locator('.quiz-setup label', { hasText: 'Fragen' }).locator('input').fill('6');
    await page.getByRole('button', { name: 'Start' }).click();
    let shotDone = false;
    for (let i = 0; i < 6; i++) {
      const card = page.locator('.quiz-card');
      await card.waitFor();
      if (await card.locator('.quiz-options input').count()) await card.locator('.quiz-options label').nth(1).click();
      else if (await card.getByRole('radio', { name: 'Wahr' }).count()) await card.getByRole('radio', { name: 'Wahr' }).click();
      else await card.locator('input.input, textarea').fill('Die Entropie eines abgeschlossenen Systems nimmt nie ab.');
      await card.getByRole('button', { name: 'Prüfen' }).click();
      await card.locator('.quiz-result').waitFor({ timeout: 15_000 });
      const res = await card.locator('.quiz-result').innerText();
      if (!/Lösung/.test(res) || !(await card.locator('.quiz-result .ref-link, .quiz-result .ref-deleted').count())) throw new Error('Lösung ohne Quelle: ' + res.slice(0, 200));
      if (!shotDone && (await card.locator('.rubric').count())) {
        await shot('phase3-quiz-freitext.png');
        shotDone = true;
      }
      const next = card.getByRole('button', { name: i === 5 ? 'Abgeben' : 'Weiter' });
      if (await next.count()) await next.click();
      else break;
    }
    if (!shotDone) await shot('phase3-quiz-freitext.png');
    await page.locator('.quiz-run h2', { hasText: 'Ergebnis' }).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Neue Runde' }).click();
    await page.locator('.weak-list li').first().waitFor({ timeout: 10_000 });
  });

  await step('Phase 3: Klausursimulation mit Timer → Abgeben → Bewertung', async () => {
    await page.getByRole('radio', { name: 'Klausursimulation' }).click();
    await page.locator('.quiz-setup label', { hasText: 'Fragen' }).locator('input').fill('3');
    await page.getByRole('button', { name: 'Start' }).click();
    await page.locator('[role=timer]', { hasText: 'Restzeit' }).waitFor();
    await shot('phase3-klausur.png');
    for (let i = 0; i < 3; i++) {
      const card = page.locator('.quiz-card');
      if (await card.locator('textarea').count()) await card.locator('textarea').fill('Entropie');
      const btn = card.getByRole('button', { name: i === 2 ? 'Abgeben' : 'Weiter' });
      await btn.click();
    }
    await page.locator('.quiz-run h2', { hasText: 'Ergebnis' }).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Neue Runde' }).click();
  });

  await step('Phase 3: Wissensgraph – Canvas, Liste (barrierefrei), Details mit Quellen, korrigieren, "Frag dazu"', async () => {
    await api('POST', '/api/learn/jobs', { kind: 'graph', scope: { kind: 'subject', id: await physik() } });
    await waitJobs();
    await page.goto(url + `/#/learn/graph?subject=${await physik()}`);
    await page.locator('.graph-canvas').waitFor();
    await page.waitForTimeout(1500);
    // Zoom per Mausrad und Verschieben per Ziehen
    const box = await page.locator('.graph-canvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -300);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
    await page.getByRole('radio', { name: 'Liste' }).click();
    await page.locator('.graph-table tbody tr').first().waitFor();
    await page.locator('.graph-table tbody tr').first().getByRole('button').click();
    await page.locator('.concept-panel .concept-sources li').first().waitFor();
    await page.getByRole('radio', { name: 'Graph' }).click();
    await page.waitForTimeout(800);
    await shot('phase3-graph.png');
    const name = (await page.locator('.concept-panel h2').innerText()).trim();
    await page.locator('.concept-panel').getByRole('button', { name: 'Frag dazu' }).click();
    await page.locator('.chat-view').waitFor();
    const v = await page.getByRole('textbox', { name: /Frag deine Unterlagen/ }).inputValue();
    if (!v.includes(name)) throw new Error('Frage nicht vorbelegt: ' + v);
    const chat = await api('GET', '/api/chats');
    if (chat[0].scope.mode !== 'sources') throw new Error('Chat ohne Quellen-Bereich');
    await api('DELETE', `/api/chats/${chat[0].id}`);
  });

  await step('Phase 3: Graph mit 2000 Knoten bleibt flüssig (Bildrate während der Simulation)', async () => {
    const sub = (await api('GET', '/api/subjects')).find((s) => s.name === 'Graph-Last').id;
    await page.goto(url + `/#/learn/graph?subject=${sub}`);
    await page.locator('.graph-canvas').waitFor();
    const fps = await page.evaluate(
      () =>
        new Promise((resolve) => {
          let frames = 0;
          let worst = 0;
          let last = performance.now();
          const t0 = last;
          const tick = (now) => {
            frames++;
            worst = Math.max(worst, now - last);
            last = now;
            if (now - t0 < 3000) requestAnimationFrame(tick);
            else resolve({ fps: Math.round((frames * 1000) / (now - t0)), worstFrameMs: Math.round(worst) });
          };
          requestAnimationFrame(tick);
        }),
    );
    const info = await page.locator('.graph-tab .toolbar').innerText();
    results.push(`INFO Graph ${GRAPH_NODES} Knoten: ${fps.fps} fps, längster Frame ${fps.worstFrameMs} ms (${info.replace(/\s+/g, ' ').trim()})`);
    if (fps.fps < 20) throw new Error(`zu langsam: ${fps.fps} fps`);
    await page.waitForTimeout(3000);
    await shot('phase3-graph-2000.png');
  });

  await step('Phase 3: Statistik (Heatmap, Prognose, Trefferquote) + Aufgaben mit Lern-Jobs', async () => {
    await page.goto(url + '/#/learn/stats');
    await page.locator('.heatmap .heat').first().waitFor();
    if (!(await page.locator('.stat-tile .hero', { hasText: '%' }).count())) throw new Error('Trefferquote fehlt');
    await shot('phase3-statistik.png');
    await page.goto(url + '/#/queue');
    await page.locator('.queue-section').waitFor();
    if ((await page.locator('.job', { hasText: 'Ergebnis öffnen' }).count()) < 3) throw new Error('Lern-Jobs fehlen in der Aufgaben-Ansicht');
    await shot('phase3-aufgaben.png');
  });

  await step('Phase 3: XSS in Notiz und Karte wird nicht ausgeführt (DOMPurify)', async () => {
    const note = await api('POST', '/api/notes', { title: 'XSS', body: '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>[1] **fett**' });
    await api('POST', '/api/cards', { type: 'qa', front: '<img src=x onerror="window.__xss=3">Frage', back: '<svg onload="window.__xss=4">' });
    await page.goto(url + `/#/learn/notes?note=${note.id}`);
    await page.locator('.note-body strong', { hasText: 'fett' }).waitFor();
    await page.goto(url + '/#/learn/cards');
    await page.getByRole('radio', { name: 'Aktiv' }).click();
    await page.locator('.card-row', { hasText: 'Frage' }).first().waitFor();
    const bad = await page.evaluate(() => ({ xss: window.__xss ?? null, handlers: document.querySelectorAll('[onerror],[onload]').length, scripts: document.querySelectorAll('.md script').length }));
    if (bad.xss !== null || bad.handlers || bad.scripts) throw new Error('XSS: ' + JSON.stringify(bad));
    await api('DELETE', `/api/notes/${note.id}`);
  });

  // ------------------------------------------------------------------ Phase 4: Sicherung, Export/Import, Diagnose, Druck
  await step('Phase 4: Sicherung erstellen, Bibliothek exportieren + wieder importieren (nur Duplikate), Wiederherstellen mit Neustart', async () => {
    await page.goto(url + '/#/backup');
    await page.getByRole('button', { name: 'Jetzt sichern' }).click();
    await page.locator('.snapshot-row').first().waitFor({ timeout: 30_000 });
    const before = await api('GET', '/api/stats');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Exportieren' }).click()]);
    if (!/^Uni-Hotspot-Export-Bibliothek-\d{4}-\d\d-\d\d\.zip$/.test(dl.suggestedFilename())) throw new Error('Export-Name: ' + dl.suggestedFilename());
    const zipPath = path.join(ROOT, '.tmp', 'e2e', 'export.zip');
    await dl.saveAs(zipPath);
    await page.locator('input[type=file][accept*=zip]').setInputFiles(zipPath);
    await page.locator('.report-list').waitFor({ timeout: 60_000 });
    const rep = await page.locator('.report-list').innerText();
    if (!/Quellen: 0 neu, \d+ schon vorhanden/.test(rep)) throw new Error('Import-Bericht: ' + rep);
    results.push(`INFO Export ${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB; Re-Import: ${rep.replace(/\s+/g, ' ')}`);
    await audit('Sicherung');
    await shot('phase4-sicherung.png');
    await api('POST', '/api/subjects', { name: 'Nach-Sicherung', color: '#ff5fd9' });
    allowNetErrors = true;
    await page.locator('.snapshot-row').first().getByRole('button', { name: /Wiederherstellen/ }).click();
    await page.locator('.dialog').getByRole('button', { name: 'Wiederherstellen' }).click();
    await page.getByText('Wird wiederhergestellt').waitFor();
    await page.locator('.toast', { hasText: 'Wiederherstellung abgeschlossen' }).waitFor({ timeout: 60_000 });
    allowNetErrors = false;
    const subs = await api('GET', '/api/subjects');
    if (subs.some((s) => s.name === 'Nach-Sicherung')) throw new Error('Fach nach der Sicherung ist noch da – nicht wiederhergestellt');
    const after = await api('GET', '/api/stats');
    if (after.sources !== before.sources || after.chunks !== before.chunks) throw new Error(`Bestand abweichend: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    const list = (await api('GET', '/api/backups')).items.map((s) => s.reason);
    if (!list.includes('pre-restore')) throw new Error('Ist-Zustand nicht gesichert: ' + list);
  });

  await step('Phase 4: Diagnose – Versionen, Status, Größen; Bericht ohne Dateinamen und Inhalte', async () => {
    await page.goto(url + '/#/diagnostics');
    await page.locator('.diag-view .kv').first().waitFor();
    const txt = await page.locator('.diag-view').innerText();
    if (!/Node\.js/.test(txt) || !/Schema 4/.test(txt)) throw new Error('Diagnose unvollständig');
    await audit('Diagnose');
    await shot('phase4-diagnose.png');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Bericht herunterladen' }).click()]);
    // direkt aus Playwrights Download-Datei lesen: eine Kopie nach .tmp (im OneDrive-Ordner) war einmal kurz gesperrt (EPERM)
    const report = fs.readFileSync(await dl.path(), 'utf8');
    if (!report.includes('--- Log (bereinigt')) throw new Error('Bericht ohne Log');
    for (const bad of ['Thermodynamik-Skript', 'Hausarbeit', 'Entropie', 'Carnot', 'Wärmekraftmaschine']) if (report.includes(bad)) throw new Error('Bericht enthält Nutzerinhalt: ' + bad);
  });

  await step('Phase 4: Notiz als PDF – im Browser-Modus Druckdialog, Druckansicht zeigt nur die Notiz', async () => {
    await page.goto(url + '/#/learn/notes');
    await page.locator('.note-item').first().click();
    await page.locator('.note-body').waitFor();
    await page.evaluate(() => {
      window.print = () => (window.__printed = (window.__printed ?? 0) + 1);
    });
    await page.getByRole('button', { name: 'PDF', exact: true }).click();
    if ((await page.evaluate(() => window.__printed)) !== 1) throw new Error('Druckdialog nicht geöffnet');
    await page.emulateMedia({ media: 'print' });
    const vis = await page.evaluate(() => ({ sidebar: getComputedStyle(document.querySelector('.sidebar')).display, note: getComputedStyle(document.querySelector('.note-body')).display }));
    if (vis.sidebar !== 'none' || vis.note === 'none') throw new Error('Druckansicht: ' + JSON.stringify(vis));
    await page.screenshot({ path: path.join(OUT, 'phase4-druckansicht-notiz.png') });
    await page.emulateMedia({ media: 'screen' });
  });

  await step('Phase 4: Assistent jederzeit wieder aufrufbar (Strg+K), Esc schließt', async () => {
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Einrichtung');
    await page.keyboard.press('Enter');
    await page.locator('.wizard').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.wizard').waitFor({ state: 'detached' });
  });

  await step('Phase 4: Barrierefreiheit – jedes Bedienelement hat einen zugänglichen Namen (alle Ansichten)', async () => {
    let total = 0;
    for (const hash of ['#/chat', '#/library', '#/search', '#/queue', '#/settings', '#/backup', '#/diagnostics', ...['review', 'cards', 'quiz', 'notes', 'graph', 'stats'].map((t) => `#/learn/${t}`)]) {
      await page.goto(url + '/' + hash);
      await page.locator('.view').first().waitFor();
      await page.waitForTimeout(500);
      total += await audit(hash);
    }
    results.push(`INFO Barrierefreiheit: ${total} Bedienelemente in 13 Ansichten geprüft, ${a11yIssues.length} ohne Namen`);
    if (a11yIssues.length) throw new Error([...new Set(a11yIssues)].slice(0, 8).join('; '));
  });

  await step('Hybrid-Suche mit Quellenangabe', async () => {
    await page.getByRole('link', { name: 'Suche' }).click();
    await page.getByPlaceholder('Begriff, Frage oder Stichwort …').fill('Entropie abgeschlossenen System');
    await page.locator('.result').first().waitFor();
    const first = await page.locator('.result').first().innerText();
    if (!first.includes('Thermodynamik-Skript.pdf') || !/S\. [\d–]+/.test(first)) throw new Error('Top-Treffer unerwartet: ' + first);
    if ((await page.locator('.result mark').count()) === 0) throw new Error('keine Markierung');
    await shot('04-suche.png');
  });

  await step('Chat streamt Antwort mit Zitaten', async () => {
    await page.getByRole('button', { name: 'Neuer Chat' }).click();
    const box = page.getByRole('textbox', { name: /Frag deine Unterlagen/ });
    await box.fill('Was besagt der zweite Hauptsatz der Thermodynamik?');
    await box.press('Enter');
    await page.locator('.msg.assistant.is-streaming').waitFor({ timeout: 10_000 });
    await page.locator('.msg.assistant:not(.is-streaming) .md button.cite').first().waitFor({ timeout: 20_000 });
    await page.locator('.msg.assistant .md button.cite').first().click();
    await page.locator('.sources-panel .cite-card.active').waitFor();
    await page.waitForTimeout(300);
    await shot('05-chat-zitate.png');
    await page.locator('.sources-panel').getByRole('button', { name: 'Schließen' }).click();
  });

  await step('Zitat -> "In Bibliothek zeigen" markiert den Abschnitt', async () => {
    await page.locator('.msg.assistant .md button.cite').first().click();
    await page.locator('.sources-panel .cite-card.active').getByRole('button', { name: 'In Bibliothek zeigen' }).click();
    await page.locator('.library-view .drawer .chunk-list li.highlight').waitFor();
    await page.goBack();
    await page.locator('.chat-view .msg.assistant').first().waitFor();
  });

  await step('Auto-Titel, Umbenennen, zweiter Chat, Löschen', async () => {
    await page.locator('.chat-item', { hasText: 'Mock: Was besagt' }).waitFor({ timeout: 10_000 });
    await page.locator('.chat-item').first().hover();
    await page.locator('.chat-item').first().getByRole('button', { name: /Umbenennen/ }).click();
    await page.locator('.dialog input').fill('Thermo-Lernsession');
    await page.locator('.dialog input').press('Enter'); // Enter darf den Dialog nicht erneut öffnen
    await page.locator('.chat-item', { hasText: 'Thermo-Lernsession' }).waitFor();
    await page.waitForTimeout(500);
    if (await page.locator('.dialog').count()) throw new Error('Umbenennen-Dialog hat sich nach Enter erneut geöffnet');
    // zweiter, freier Chat
    await page.getByRole('button', { name: 'Neuer Chat' }).click();
    await page.getByRole('button', { name: /Alle Quellen/ }).click();
    await page.getByLabel('Ohne Quellen (freier Chat)').check();
    await page.keyboard.press('Escape');
    const box = page.getByRole('textbox', { name: /Frag deine Unterlagen/ });
    await box.fill('Erzähl mir etwas über Lernmethoden');
    await box.press('Enter');
    await page.locator('.msg.assistant:not(.is-streaming)').waitFor({ timeout: 15_000 });
    if ((await page.locator('.chat-item').count()) !== 2) throw new Error('erwartet 2 Chats');
    // erster Chat hat weiterhin eigenen Verlauf
    await page.locator('.chat-item', { hasText: 'Thermo-Lernsession' }).locator('a').click();
    await page.locator('.msg.user', { hasText: 'zweite Hauptsatz' }).waitFor();
    // löschen
    const freeChat = page.locator('.chat-item').filter({ hasNotText: 'Thermo-Lernsession' });
    await freeChat.hover();
    await freeChat.getByRole('button', { name: /Löschen/ }).click();
    await page.locator('.dialog').getByRole('button', { name: 'Löschen' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.chat-item').length === 1);
  });

  await step('Chat-Verlauf durchsuchen', async () => {
    await page.getByPlaceholder('Chats durchsuchen …').fill('Hauptsatz');
    await page.locator('.chat-item em').first().waitFor();
    await page.getByPlaceholder('Chats durchsuchen …').fill('');
  });

  // Regressionstests der UI-Fixes aus fac53c4 (K18)
  await step('Regression: Befehlspalette – Enter führt den obersten Treffer aus, nicht das Element unter dem Mauszeiger', async () => {
    // 1) Position von „In Unterlagen suchen“ in der gefilterten Liste ermitteln (2. Treffer nach „Bibliothek“)
    await page.keyboard.press('Control+k');
    await page.locator('.palette input:focus').waitFor();
    await page.keyboard.insertText('Bib');
    const box = await page.locator('.palette-item', { hasText: 'In Unterlagen suchen' }).boundingBox();
    await page.keyboard.press('Escape');
    await page.locator('.palette').waitFor({ state: 'detached' });
    // 2) Mauszeiger steht dort, BEVOR die Palette aufgeht (wie nach einem Klick in einen Dialog); dann tippen: der Suchtreffer
    //    erscheint unter dem stehenden Zeiger – vor dem Fix markierte Chromiums künstliches mouseenter ihn, Enter startete die Suche
    await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 5 });
    await page.keyboard.press('Control+k');
    await page.locator('.palette input:focus').waitFor();
    await page.keyboard.type('Bib');
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.locator('.library-view').waitFor({ timeout: 5000 });
    await page.goBack();
    await page.locator('.chat-view').waitFor();
  });

  await step('Regression: „Neuer Chat“ beginnt mit „Alle Quellen“, auch wenn der vorige Entwurf „Ohne Quellen“ hatte', async () => {
    await page.getByRole('button', { name: 'Neuer Chat' }).click();
    await page.getByRole('button', { name: /Alle Quellen/ }).click();
    await page.getByLabel('Ohne Quellen (freier Chat)').check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Ohne Quellen/ }).waitFor();
    await page.locator('.chat-item').first().locator('a').click();
    await page.locator('.msg').first().waitFor();
    await page.getByRole('button', { name: 'Neuer Chat' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.msg').length === 0); // Entwurf ist offen
    await page.waitForTimeout(200);
    if (await page.getByRole('button', { name: /Ohne Quellen/ }).count()) throw new Error('Entwurf übernimmt „Ohne Quellen“');
    await page.getByRole('button', { name: /Alle Quellen/ }).waitFor({ timeout: 2000 });
  });

  await step('Regression: Text direkt nach „Neuer Chat“ abgeschickt landet im neuen Chat, nicht im vorher offenen', async () => {
    await page.locator('.chat-item').first().locator('a').click();
    await page.locator('.msg').first().waitFor();
    const before = await api('GET', '/api/chats');
    const oldId = before[0].id;
    const oldCount = (await api('GET', `/api/chats/${oldId}`)).messages.length;
    // Klick, Tippen und Enter in EINER Aufgabe des Browsers (wie schnelles Tippen direkt nach dem Klick): vor dem Fix schaltete
    // die Route erst beim asynchronen hashchange um, die Nachricht ging an den noch offenen Chat
    await page.evaluate(() => {
      document.querySelector('button.new-chat').click();
      const ta = document.querySelector('.composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'Sofort-Frage zur Entropie');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await page.waitForFunction((n) => document.querySelectorAll('.chat-item').length === n + 1, before.length, { timeout: 10_000 });
    await page.locator('.msg.assistant:not(.is-streaming)').last().waitFor({ timeout: 15_000 });
    if ((await api('GET', `/api/chats/${oldId}`)).messages.length !== oldCount) throw new Error('Nachricht im alten Chat gelandet');
    const item = page.locator('.chat-item.active', { hasText: 'Sofort-Frage' }); // aktiver Chat = der neue (Auto-Titel)
    await item.waitFor({ timeout: 10_000 });
    await item.hover();
    await item.getByRole('button', { name: /Löschen/ }).click();
    await page.locator('.dialog').getByRole('button', { name: 'Löschen' }).click();
    await page.waitForFunction((n) => document.querySelectorAll('.chat-item').length === n, before.length);
    await page.locator('.chat-item').first().locator('a').click(); // Ausgangslage für die folgenden Schritte
    await page.locator('.msg').first().waitFor();
  });

  await step('Stopp während des Streamings: Teiltext + "Abgebrochen", Neu generieren möglich', async () => {
    await page.getByRole('button', { name: 'Neuer Chat' }).click();
    const box = page.getByRole('textbox', { name: /Frag deine Unterlagen/ });
    await box.fill('__MOCK_SLOW__ Erkläre mir bitte ausführlich die Entropie');
    await box.press('Enter');
    await page.locator('.msg.assistant.is-streaming .md').waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Stopp' }).click();
    const msg = page.locator('.msg.assistant').last();
    await msg.getByText('Abgebrochen').waitFor({ timeout: 6000 });
    if (!(await msg.locator('.md').innerText()).trim()) throw new Error('Teiltext fehlt');
    if (await page.locator('.typing').count()) throw new Error('Tipp-Punkte hängen');
    await msg.getByRole('button', { name: 'Neu generieren' }).waitFor();
    await page.waitForTimeout(1500); // Server-Stand bleibt "abgebrochen" (kein Rücksprung)
    await msg.getByText('Abgebrochen').waitFor();
    const item = page.locator('.chat-item.active');
    await item.hover();
    await item.getByRole('button', { name: /Löschen/ }).click();
    await page.locator('.dialog').getByRole('button', { name: 'Löschen' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.chat-item').length === 1);
  });

  await step('Command-Palette (Strg+K)', async () => {
    await page.keyboard.press('Control+k');
    await page.locator('.palette input:focus').waitFor();
    await page.keyboard.type('Bib');
    await page.waitForTimeout(200);
    await shot('06-command-palette.png');
    await page.keyboard.press('Enter');
    await page.locator('.library-view').waitFor();
  });

  await step('Fach umbenennen und löschen', async () => {
    const row = page.locator('.subject-row', { hasText: 'Physik' });
    await row.hover();
    await row.getByRole('button', { name: /Fach bearbeiten/ }).click();
    await page.locator('.subject-form input').fill('Physik II');
    await page.locator('.subject-form').getByRole('button', { name: 'Speichern' }).click();
    await page.locator('.subject-item', { hasText: 'Physik II' }).waitFor();
    const r2 = page.locator('.subject-row', { hasText: 'Physik II' });
    await r2.hover();
    await r2.getByRole('button', { name: /Fach löschen/ }).click();
    await page.locator('.dialog').getByRole('button', { name: /Quellen behalten/ }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.subject-item')].some((e) => e.textContent?.includes('Physik II')));
  });

  await step('Quelle löschen', async () => {
    await page.getByRole('link', { name: 'Alle Quellen' }).click();
    const row = page.locator('.source-row', { hasText: 'Tafelbild.png' });
    await row.getByRole('button', { name: /Löschen/ }).click();
    await page.locator('.dialog').getByRole('button', { name: 'Löschen' }).click();
    await row.waitFor({ state: 'detached' });
  });

  await step('Einstellungen + Sprache EN', async () => {
    await page.getByRole('link', { name: 'Einstellungen' }).click();
    await page.locator('.settings-section').first().waitFor();
    await shot('07-einstellungen.png');
    await page.getByRole('radiogroup', { name: 'Sprache', exact: true }).getByRole('radio', { name: 'English' }).click();
    await page.getByRole('link', { name: 'Library' }).waitFor();
    await page.getByRole('link', { name: 'Chat' }).click();
    await page.locator('.chat-item').first().locator('a').click();
    await page.locator('.msg.assistant').first().waitFor();
    await shot('08-chat-english.png');
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('radiogroup', { name: 'Language', exact: true }).getByRole('radio', { name: 'Deutsch' }).click();
    await page.getByRole('link', { name: 'Bibliothek' }).waitFor();
  });

  await step('Helles Farbschema', async () => {
    await page.getByRole('radio', { name: /Hell/ }).click();
    await page.getByRole('link', { name: 'Suche' }).click();
    await page.getByPlaceholder('Begriff, Frage oder Stichwort …').fill('Carnot');
    await page.locator('.result').first().waitFor();
    await shot('09-suche-hell.png');
    await page.getByRole('link', { name: 'Einstellungen' }).click();
    await page.getByRole('radio', { name: /Dunkel/ }).click();
  });

  await step('Quellenzeilen lesbar: mit Vorschau-Panel, 1000 px mit Seitenleiste, 1280 px', async () => {
    // Zeilenlayout hängt an der Listenbreite: Dateiname nie auf 0 px gequetscht, nichts ragt aus der Zeile
    const check = (label) =>
      page.evaluate((label) => {
        const bad = [];
        let minName = Infinity;
        for (const row of document.querySelectorAll('.source-row')) {
          const r = row.getBoundingClientRect();
          const name = row.querySelector('.source-name');
          if (name) minName = Math.min(minName, name.getBoundingClientRect().width);
          for (const el of row.querySelectorAll('.source-main, .badge, .source-stat, .source-size, .source-date, .source-actions')) {
            const b = el.getBoundingClientRect();
            if (b.width > 0 && b.right > r.right + 1) bad.push(`${label}: ${el.className.split(' ')[0]} ragt aus der Zeile`);
          }
        }
        if (minName < 80) bad.push(`${label}: Dateiname nur ${Math.round(minName)}px breit`);
        return bad;
      }, label);
    const problems = [];
    await page.getByRole('link', { name: 'Bibliothek' }).click();
    await page.locator('.source-row').first().waitFor();
    await page.locator('.source-row', { hasText: 'Thermodynamik-Skript.pdf' }).locator('.source-main').click();
    await page.locator('.drawer .chunk-list li').first().waitFor();
    await page.waitForTimeout(400);
    problems.push(...(await check('1440 px + Vorschau')));
    await page.locator('.drawer').getByRole('button', { name: 'Schließen' }).click();
    for (const width of [1280, 1000]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(350);
      problems.push(...(await check(`${width} px`)));
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    if (problems.length) throw new Error(problems.slice(0, 4).join('; '));
  });

  await step('Schmales Fenster (Mobil-Layout)', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url + '/#/chat');
    await page.waitForTimeout(600);
    if (await page.locator('.sidebar.open').count()) throw new Error('Seitenleiste sollte im schmalen Fenster eingeklappt sein');
    await page.locator('.chat-item').first().waitFor({ state: 'attached' });
    await page.goto(url + '/#/chat/' + (await page.evaluate(() => fetch('/api/chats', { headers: { 'x-hotspot-token': document.querySelector('meta[name=hotspot-token]').content } }).then((r) => r.json()).then((c) => c[0].id))));
    await page.locator('.msg.assistant').first().waitFor();
    await shot('10-schmal-chat.png');
    await page.getByRole('button', { name: 'Seitenleiste ausklappen' }).click();
    await page.locator('.sidebar.open').waitFor();
    await shot('11-schmal-menue.png');
    await page.keyboard.press('Escape');
    await page.locator('.sidebar.closed').waitFor({ state: 'attached' });
    await page.goto(url + '/#/library');
    await page.locator('.source-row').first().waitFor();
    await shot('12-schmal-bibliothek.png');
  });

  await step('Fach-Auswahl bei 600 px nicht abgeschnitten', async () => {
    await page.setViewportSize({ width: 600, height: 900 });
    await page.goto(url + '/#/library');
    await page.locator('.source-row .move-select').first().waitFor();
    const w = await page.locator('.source-row .move-select').first().evaluate((el) => el.getBoundingClientRect().width);
    if (w < 130) throw new Error(`Select nur ${w}px breit`);
    await page.setViewportSize({ width: 390, height: 844 });
  });

  await step('Phase 2: Aufgaben + Medien-Einstellungen bei 600 px', async () => {
    await page.setViewportSize({ width: 600, height: 900 });
    await page.goto(url + '/#/queue');
    await page.locator('.job').first().waitFor();
    await shot('18-schmal-aufgaben.png');
    for (const hash of ['#/queue', '#/settings']) {
      await page.goto(url + '/' + hash);
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) throw new Error(`${hash}: horizontaler Überlauf ${overflow}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
  });

  await step('Phase 3: Lernen bei 600 px (alle Tabs ohne horizontalen Überlauf)', async () => {
    await page.setViewportSize({ width: 600, height: 900 });
    for (const tab of ['review', 'cards', 'quiz', 'notes', 'graph', 'stats']) {
      await page.goto(url + `/#/learn/${tab}`);
      await page.locator('.learn-body').waitFor();
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) throw new Error(`${tab}: horizontaler Überlauf ${overflow}px`);
      if (tab === 'quiz') await shot('phase3-schmal-quiz.png');
    }
    await page.goto(url + '/#/learn/notes');
    await page.locator('.note-item').first().click();
    await page.locator('.note-body').waitFor();
    await shot('phase3-schmal-notiz.png');
    await page.setViewportSize({ width: 390, height: 844 });
  });

  await step('Phase 4: Sicherung, Diagnose, Assistent bei 600 px (kein horizontaler Überlauf)', async () => {
    await page.setViewportSize({ width: 600, height: 900 });
    const noOverflow = async (label) => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) throw new Error(`${label}: horizontaler Überlauf ${overflow}px`);
    };
    for (const [hash, name] of [
      ['#/backup', 'phase4-schmal-sicherung.png'],
      ['#/diagnostics', 'phase4-schmal-diagnose.png'],
    ]) {
      await page.goto(url + '/' + hash);
      await page.locator('.settings-section').first().waitFor();
      await page.waitForTimeout(400);
      await noOverflow(hash);
      await shot(name);
    }
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Einrichtung');
    await page.keyboard.press('Enter');
    await page.locator('.wizard').getByRole('button', { name: 'Weiter' }).click();
    await page.locator('.wizard .wiz-checks li').first().waitFor();
    await noOverflow('Assistent');
    await shot('phase4-schmal-assistent.png');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
  });

  await step('Keine horizontale Scrollbar im schmalen Layout', async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) throw new Error(`horizontaler Überlauf ${overflow}px`);
  });

  // Runde 2 (T1): große Bibliothek. Zeilenhöhe mit Nachkommastellen fest vorgeben (wie 58,19 px bei manchen Schriften/Zoomstufen),
  // damit der Test unabhängig von der Umgebung rot wird, wenn das Fenster mit gerundeter Höhe rechnet
  {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addStyleTag({ content: '.source-row{height:52.19px!important;min-height:0!important;box-sizing:border-box!important;overflow:hidden!important}' });
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path.join(DATA, 'hotspot.sqlite'));
    raw.exec('PRAGMA busy_timeout = 10000');
    const col = '.library-view .source-col';
    const openAll = async () => {
      await page.evaluate(() => (location.hash = '#/chat'));
      await page.locator('.chat-view').waitFor();
      await page.evaluate(() => (location.hash = '#/library'));
      await page.getByRole('link', { name: 'Alle Quellen' }).click();
      await page.locator('.source-row').first().waitFor();
    };
    const toBottom = async () => {
      for (let i = 0; i < 400; i++) {
        const more = await page.evaluate((sel) => {
          const c = document.querySelector(sel);
          c.scrollTop = c.scrollHeight;
          return !!document.querySelector('.source-more');
        }, col);
        if (!more) break;
        await page.waitForTimeout(80);
      }
      await page.evaluate((sel) => (document.querySelector(sel).scrollTop = 1e9), col);
      await page.waitForTimeout(400);
    };
    /** sichtbarer Bereich der Spalte vollständig mit Zeilen belegt? Liefert Lücke oben/unten in px */
    const coverage = () =>
      page.evaluate((sel) => {
        const c = document.querySelector(sel).getBoundingClientRect();
        const rows = [...document.querySelectorAll('.source-row')].map((r) => r.getBoundingClientRect());
        return { top: Math.max(0, rows[0].top - c.top), bottom: Math.max(0, c.bottom - rows[rows.length - 1].bottom) };
      }, col);
    await step('Runde 2: Bibliothek mit 5 200 und 20 000 Quellen – letzte Zeile erreichbar (Zeilenabstand 58,19 px)', async () => {
    for (const target of [5200, 20_000]) {
      const have = raw.prepare('SELECT count(*) AS n FROM sources').get().n;
      raw.exec('BEGIN');
      const ins = raw.prepare("INSERT INTO sources(sha256, name, size, mime, kind, status, imported_at, chunk_count) VALUES (?, ?, 1000, 'application/pdf', 'pdf', 'ready', ?, 0)");
      for (let i = have; i < target; i++) ins.run(String(i).padStart(64, '0'), `Last-${i}.pdf`, 1000 + i);
      raw.exec('COMMIT');
      await openAll();
      await toBottom();
      const last = await page.evaluate((sel) => {
        const c = document.querySelector(sel).getBoundingClientRect();
        const rows = [...document.querySelectorAll('.source-row')];
        const r = rows[rows.length - 1];
        const b = r.getBoundingClientRect();
        return { pos: Number(r.getAttribute('aria-posinset')), size: Number(r.getAttribute('aria-setsize')), visible: b.top >= c.top - 1 && b.bottom <= c.bottom + 1 };
      }, col);
      if (last.size !== target || last.pos !== target || !last.visible) throw new Error(`${target} Quellen: letzte gerenderte Zeile ${last.pos}/${last.size}, sichtbar ${last.visible}`);
    }
    });
    // Zeilenhöhe ändert sich (z. B. Vorschau-Panel macht die Liste schmaler): Fenster passt sich ohne Scrollen an
    await step('Runde 2: Zeilenhöhe ändert sich ohne Scrollen -> Fenster passt sich an (ResizeObserver)', async () => {
    await openAll();
    await page.evaluate((sel) => (document.querySelector(sel).scrollTop = document.querySelector(sel).scrollHeight / 2), col);
    await page.waitForTimeout(300);
    const shrink = await page.addStyleTag({ content: '.source-row{height:30px!important}' });
    await page.waitForTimeout(500);
    const gap = await coverage();
    if (gap.top > 1 || gap.bottom > 1) throw new Error(`nach Höhenänderung ohne Scrollen Lücke oben ${gap.top}px / unten ${gap.bottom}px`);
    await shrink.evaluate((el) => el.remove());
    });
    // Fokus: Zeile fokussieren, weit wegscrollen -> Fokus bleibt in der Liste (nicht <body>)
    await step('Runde 2: fokussierte Zeile scrollt aus dem Fenster -> Fokus bleibt in der Liste', async () => {
    await page.evaluate((sel) => (document.querySelector(sel).scrollTop = 0), col);
    await page.waitForTimeout(300);
    await page.locator('.source-row .source-main').first().focus();
    await page.evaluate((sel) => (document.querySelector(sel).scrollTop = 1e9), col);
    await page.waitForTimeout(500);
    const focus = await page.evaluate(() => (document.activeElement?.closest('.source-list') ? 'liste' : document.activeElement?.tagName));
    if (focus !== 'liste') throw new Error('Fokus verloren an ' + focus);
    });
    raw.close();
  }
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

for (const e of expectedConsole) {
  const i = errors.findIndex((x) => x.includes(e));
  if (i !== -1) errors.splice(i, 1);
}
console.log(results.join('\n'));
if (errors.length) console.log('\nBrowser-Fehler:\n' + errors.join('\n'));
console.log(`\nScreenshots: ${OUT}`);
const failed = results.some((r) => r.startsWith('FAIL')) || errors.length > 0;
if (failed) console.log('\nServer-Log:\n' + serverLog.slice(-3000));
process.exit(failed ? 1 : 0);
