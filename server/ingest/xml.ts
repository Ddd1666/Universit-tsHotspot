/**
 * Minimaler, robuster XML-Tokenizer für Office-Dateien (OOXML/ODF).
 * Kein DOM, keine DTD/Entity-Expansion (-> kein XXE / Billion-Laughs), linear in der Eingabelänge.
 */

export type XmlToken =
  | { type: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: 'close'; name: string }
  | { type: 'text'; text: string };

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return m;
      return String.fromCodePoint(code);
    }
    return NAMED[body] ?? m;
  });
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) attrs[m[1]!] = decodeEntities(m[3] ?? m[4] ?? '');
  return attrs;
}

export function* tokenize(xml: string): Generator<XmlToken> {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      const text = xml.slice(i);
      if (text) yield { type: 'text', text: decodeEntities(text) };
      return;
    }
    if (lt > i) yield { type: 'text', text: decodeEntities(xml.slice(i, lt)) };
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      const text = xml.slice(lt + 9, end === -1 ? n : end);
      if (text) yield { type: 'text', text };
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml[lt + 1] === '?' || xml[lt + 1] === '!') {
      const end = xml.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt === -1) return;
    const inner = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (inner[0] === '/') {
      yield { type: 'close', name: inner.slice(1).trim() };
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const sp = body.search(/\s/);
    const name = sp === -1 ? body : body.slice(0, sp);
    const attrs = sp === -1 ? {} : parseAttrs(body.slice(sp));
    yield { type: 'open', name, attrs, selfClosing };
  }
}

/** Alle Textknoten innerhalb eines bestimmten Elementnamens (z. B. 'a:t'), verbunden. */
export function collectText(xml: string, textTag: string): string {
  let depth = 0;
  let out = '';
  for (const t of tokenize(xml)) {
    if (t.type === 'open' && t.name === textTag && !t.selfClosing) depth++;
    else if (t.type === 'close' && t.name === textTag) depth = Math.max(0, depth - 1);
    else if (t.type === 'text' && depth > 0) out += t.text;
  }
  return out;
}
