import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Markdown -> sicheres HTML. Modell-Ausgaben und Dokumentinhalte sind NICHT vertrauenswürdig:
 * alles läuft durch DOMPurify (Skripte, Event-Handler, javascript:-Links, externe Bilder werden entfernt).
 * Zitate [n] werden danach per DOM-API als Buttons eingesetzt (kein String-HTML).
 */

type Katex = { renderToString(tex: string, opts: Record<string, unknown>): string };
let katex: Katex | null = null;
let katexPromise: Promise<void> | null = null;

/** KaTeX wird nur bei Bedarf geladen (hält das Start-Bundle klein). */
export function ensureKatex(): Promise<void> {
  if (katex) return Promise.resolve();
  if (!katexPromise) {
    katexPromise = Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([mod]) => {
      katex = (mod as unknown as { default: Katex }).default;
    });
  }
  return katexPromise;
}

export function katexLoaded(): boolean {
  return katex !== null;
}

export function hasMath(src: string): boolean {
  return /\$\$|\\\[|\\\(|\$[^\s$][^$\n]*\$/.test(src);
}

let hooksInstalled = false;
function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (!/^(https?:|mailto:)/i.test(href)) el.removeAttribute('href');
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    // kein CSS mit URLs/Ausdrücken aus Modellausgaben (KaTeX braucht nur einfache Inline-Styles)
    const style = el.getAttribute?.('style');
    if (style && /url\s*\(|expression|@import|javascript:/i.test(style)) el.removeAttribute('style');
    if (el.tagName === 'IMG') {
      // keine externen Bilder (Tracking / Netzwerkzugriffe), nur eingebettete Rasterbilder
      const src = el.getAttribute('src') ?? '';
      if (!/^data:image\/(png|jpe?g|gif|webp);/i.test(src)) el.remove();
    }
  });
}

const CODE_SPLIT = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/g;
const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?![\s$])([^\n$]+?)(?<!\s)\$(?![\w$])/g;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function renderMath(tex: string, display: boolean): string {
  if (!katex) return escapeHtml(display ? `$$${tex}$$` : `$${tex}$`);
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml', trust: false, strict: 'ignore', maxSize: 50, maxExpand: 500 });
  } catch {
    return escapeHtml(tex);
  }
}

export function sanitizeHtml(html: string): string {
  installHooks();
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'object', 'embed', 'frame', 'link', 'meta', 'base'],
    FORBID_ATTR: ['srcset', 'action', 'formaction', 'xlink:href'],
    ALLOW_DATA_ATTR: false,
  });
}

/** [n]-Zitate (1..maxCite) in Textknoten durch Buttons ersetzen – nicht in Code/Links. */
function insertCitations(html: string, maxCite: number): string {
  if (maxCite <= 0 || !/\[\d{1,3}\]/.test(html)) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (/\[\d{1,3}\]/.test(n.nodeValue ?? '') && !(n.parentElement?.closest('code, pre, a, .katex'))) targets.push(n as Text);
  }
  for (const textNode of targets) {
    const parts = (textNode.nodeValue ?? '').split(/(\[\d{1,3}\])/);
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      const m = /^\[(\d{1,3})\]$/.exec(part);
      const num = m ? Number(m[1]) : 0;
      if (m && num >= 1 && num <= maxCite) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cite';
        btn.setAttribute('data-cite', String(num));
        btn.textContent = String(num);
        frag.appendChild(btn);
      } else if (part) frag.appendChild(document.createTextNode(part));
    }
    textNode.replaceWith(frag);
  }
  return tpl.innerHTML;
}

/**
 * Schutz vor quadratischer Laufzeit in marked: viele *unausgeglichene* Hervorhebungszeichen in EINEM Absatz
 * (z. B. "*a " × 13 000 ≈ 16 s CPU) blockieren sonst die Oberfläche. Gemessen wächst die Zeit mit dem Quadrat der
 * Zeichen `*`, `_`, `~` pro Absatz/Listenpunkt (≈ 1 300 → 200 ms, 400 → 18 ms); Länge allein ist unkritisch.
 * In Einheiten über dem Limit (und ab einer Gesamtmenge pro Nachricht) werden diese Zeichen maskiert: sie erscheinen
 * unverändert als Text, nur die Hervorhebung entfällt – Listen, Links, Code bleiben Markdown.
 */
export const EMPHASIS_UNIT_LIMIT = 300;
export const EMPHASIS_TOTAL_LIMIT = 1200;
const LIST_PREFIX = /^(\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+)/;
const UNIT_START = /^\s*$|^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s|^\s*(?:\||#{1,6}\s|>)/;

function countEmphasis(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 42 || c === 95 || c === 126) n++; // * _ ~
  }
  return n;
}

export function defuseEmphasis(text: string): string {
  const lines = text.split('\n');
  let total = 0;
  let start = 0;
  const unit = (end: number) => {
    let d = 0;
    for (let i = start; i < end; i++) d += countEmphasis(lines[i]!);
    if (d === 0) return;
    if (d <= EMPHASIS_UNIT_LIMIT && total + d <= EMPHASIS_TOTAL_LIMIT) {
      total += d;
      return;
    }
    for (let i = start; i < end; i++) {
      const line = lines[i]!;
      const prefix = LIST_PREFIX.exec(line)?.[1] ?? ''; // Listenzeichen "* " bleibt Listenzeichen
      lines[i] = prefix + line.slice(prefix.length).replace(/[*_~]/g, '\\$&');
    }
  };
  for (let i = 0; i < lines.length; i++) {
    if (i > start && UNIT_START.test(lines[i]!)) {
      unit(i);
      start = i;
    }
  }
  unit(lines.length);
  return lines.join('\n');
}

export function renderMarkdown(src: string, opts: { maxCite?: number } = {}): string {
  const math: string[] = [];
  const code: string[] = [];
  const prepared = src
    .split(CODE_SPLIT)
    .map((seg, i) => {
      if (i % 2 === 1) {
        code.push(seg); // Code bleibt unverändert (auch nicht maskiert)
        return `@@CODE${code.length - 1}@@`;
      }
      return seg.replace(MATH_RE, (_m, d1: string, d2: string, i1: string, i2: string) => {
        const display = d1 !== undefined || d2 !== undefined;
        const tex = (d1 ?? d2 ?? i1 ?? i2 ?? '').trim();
        math.push(renderMath(tex, display));
        return `@@MATH${math.length - 1}@@`;
      });
    })
    .join('');
  const safe = defuseEmphasis(prepared).replace(/@@CODE(\d+)@@/g, (_m, n: string) => code[Number(n)] ?? '');
  let html = marked.parse(safe, { gfm: true, breaks: false, async: false }) as string;
  if (math.length) html = html.replace(/@@MATH(\d+)@@/g, (_m, n: string) => math[Number(n)] ?? '');
  return insertCitations(sanitizeHtml(html), opts.maxCite ?? 0);
}
