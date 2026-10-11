// Browser-End-to-End-Check (Playwright/Chromium) gegen den Mock-Modus.
//   node scripts/e2e-browser.mjs [Screenshot-Ordner]
// Benötigt eine Playwright-Installation (nicht Teil der App-Abhängigkeiten):
//   PLAYWRIGHT_MODULE=<pfad/zu/playwright/index.mjs>  CHROMIUM_PATH=<pfad/zu/chrome>
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureWebBuild, NODE_FLAGS, ROOT } from './lib.mjs';

const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, '.tmp', 'e2e', 'screens'));
const PW = process.env.PLAYWRIGHT_MODULE ?? '/opt/node22/lib/node_modules/playwright/index.mjs';
const CHROME = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = Number(process.env.E2E_PORT ?? 4391);
const DATA = path.join(ROOT, '.tmp', 'e2e', `data-${Date.now()}`);
const FILES = path.join(ROOT, '.tmp', 'e2e', 'files');

const { chromium } = await import(PW);
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
  'Tafelbild.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
};
for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(FILES, name), data);

// --- Server starten (Mock-Ollama)
const server = spawn(process.execPath, [...NODE_FLAGS, path.join(ROOT, 'server', 'main.ts')], {
  cwd: ROOT,
  env: { ...process.env, HOTSPOT_MOCK_OLLAMA: '1', HOTSPOT_PORT: String(PORT), HOTSPOT_DATA_DIR: DATA },
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
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
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
  await page.waitForTimeout(450); // Einblend-Animationen abwarten
  await page.screenshot({ path: path.join(OUT, name) });
};

try {
  await step('App lädt', async () => {
    await page.goto(url);
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
    await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(Object.keys(files).map((n) => path.join(FILES, n)));
    await page.locator('.import-panel').waitFor();
    await page.waitForFunction(() => {
      const states = [...document.querySelectorAll('.import-state')].map((e) => e.textContent ?? '');
      return states.length === 6 && states.every((s) => /indexiert|Archiv entpackt|nur gespeichert/.test(s));
    }, null, { timeout: 30_000 });
    await page.locator('.source-row', { hasText: 'aufgabe1.md' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.source-row').length >= 8, null, { timeout: 15_000 });
    await page.waitForTimeout(1800); // Vektor-Fortschritt
    await shot('02-bibliothek-import.png');
  });

  await step('Quellen-Vorschau', async () => {
    await page.locator('.source-row', { hasText: 'Thermodynamik-Skript.pdf' }).locator('.source-main').click();
    await page.locator('.drawer .chunk-list li').first().waitFor();
    if (!/S\. \d/.test(await page.locator('.drawer').innerText())) throw new Error('Seitenangabe fehlt');
    await shot('03-quellen-vorschau.png');
    await page.locator('.drawer').getByRole('button', { name: 'Schließen' }).click();
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

  await step('Auto-Titel, Umbenennen, zweiter Chat, Löschen', async () => {
    await page.locator('.chat-item', { hasText: 'Mock: Was besagt' }).waitFor({ timeout: 10_000 });
    await page.locator('.chat-item').first().hover();
    await page.locator('.chat-item').first().getByRole('button', { name: /Umbenennen/ }).click();
    await page.locator('.dialog input').fill('Thermo-Lernsession');
    await page.locator('.dialog').getByRole('button', { name: 'Speichern' }).click();
    await page.locator('.chat-item', { hasText: 'Thermo-Lernsession' }).waitFor();
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
    await page.getByRole('radio', { name: 'English' }).click();
    await page.getByRole('link', { name: 'Library' }).waitFor();
    await page.getByRole('link', { name: 'Chat' }).click();
    await page.locator('.chat-item').first().locator('a').click();
    await page.locator('.msg.assistant').first().waitFor();
    await shot('08-chat-english.png');
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'Deutsch' }).click();
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

  await step('Keine horizontale Scrollbar im schmalen Layout', async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) throw new Error(`horizontaler Überlauf ${overflow}px`);
  });
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

console.log(results.join('\n'));
if (errors.length) console.log('\nBrowser-Fehler:\n' + errors.join('\n'));
console.log(`\nScreenshots: ${OUT}`);
const failed = results.some((r) => r.startsWith('FAIL')) || errors.length > 0;
if (failed) console.log('\nServer-Log:\n' + serverLog.slice(-3000));
process.exit(failed ? 1 : 0);
