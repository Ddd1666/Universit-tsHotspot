// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureKatex, renderMarkdown, sanitizeHtml } from '../web/src/lib/markdown.ts';
import { snippetParts } from '../web/src/lib/format.ts';

function dom(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

/** Prüft alle Attribute aller Elemente auf ausführbare Inhalte (Text darf "javascript:" enthalten – das ist harmlos). */
function expectNoActiveContent(el: HTMLElement) {
  for (const node of el.querySelectorAll('*')) {
    for (const attr of node.attributes) {
      expect(attr.name.startsWith('on'), `${node.tagName} ${attr.name}`).toBe(false);
      expect(attr.value, `${node.tagName} ${attr.name}`).not.toMatch(/^\s*javascript:|url\s*\(/i);
    }
  }
}

describe('Markdown-Rendering mit XSS-Schutz', () => {
  beforeAll(async () => {
    await ensureKatex();
  });

  it('entfernt Skripte, Event-Handler, javascript:-Links, iframes, Formulare', () => {
    const evil = [
      '<script>alert(1)</script>',
      '<img src=x onerror="alert(2)">',
      '[klick](javascript:alert(3))',
      '<a href="javascript:alert(4)">x</a>',
      '<iframe src="https://evil.example"></iframe>',
      '<form action="https://evil.example"><input name=a></form>',
      '<svg><script>alert(5)</script></svg>',
      '<div style="background:url(javascript:alert(6))" onclick="alert(7)">d</div>',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(8)>',
    ].join('\n\n');
    const html = renderMarkdown(evil);
    const el = dom(html);
    expect(el.querySelector('script, iframe, form, input, style')).toBeNull();
    expectNoActiveContent(el);
    expect(el.querySelectorAll('a[href]')).toHaveLength(0);
  });

  it('blockiert externe Bilder (keine Netzwerkzugriffe/Tracking), erlaubt eingebettete', () => {
    const el = dom(renderMarkdown('![t](https://tracker.example/p.png)\n\n![ok](data:image/png;base64,iVBORw0KGgo=)'));
    const imgs = [...el.querySelectorAll('img')];
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute('src')).toMatch(/^data:image\/png/);
  });

  it('externe Links öffnen sicher in neuem Fenster', () => {
    const a = dom(renderMarkdown('[Doku](https://example.org)')).querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('wandelt [n] in Zitat-Buttons um – nur gültige Nummern, nicht in Code', () => {
    const html = renderMarkdown('Fakt [1] und [2][3], aber [9] gibt es nicht.\n\n`code [1]`\n\n```\n[2]\n```', { maxCite: 3 });
    const el = dom(html);
    const cites = [...el.querySelectorAll('button.cite')].map((b) => b.getAttribute('data-cite'));
    expect(cites).toEqual(['1', '2', '3']);
    expect(el.textContent).toContain('[9]');
    expect(el.querySelector('code')!.textContent).toBe('code [1]');
  });

  it('rendert Tabellen, Listen und Formeln (KaTeX) ohne unsichere Ausgabe', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n- eins\n- zwei\n\nInline $E = mc^2$ und\n\n$$\\int_0^1 x\\,dx$$\n\n$\\href{javascript:alert(1)}{x}$');
    const el = dom(html);
    expect(el.querySelector('table')).not.toBeNull();
    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect(el.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2);
    expectNoActiveContent(el);
    expect(el.querySelector('a')).toBeNull(); // \\href wird von KaTeX (trust: false) nicht als Link erzeugt
  });

  it('sanitizeHtml ist auch direkt sicher', () => {
    expect(sanitizeHtml('<b onmouseover="x()">fett</b><base href="https://evil/">')).toBe('<b>fett</b>');
  });

  it('Such-Snippets: Markierungen ohne innerHTML', () => {
    expect(snippetParts('a \u0002Treffer\u0003 <b>z</b>')).toEqual([
      { text: 'a ', mark: false },
      { text: 'Treffer', mark: true },
      { text: ' <b>z</b>', mark: false },
    ]);
  });
});

describe('Markdown: Schutz vor quadratischer Laufzeit (unausgeglichene Hervorhebungen)', () => {
  const timed = (src: string) => {
    const t = performance.now();
    const html = renderMarkdown(src);
    return { ms: performance.now() - t, html };
  };

  it('"*a " × 13 000 (vorher ~16 s im UI-Thread) und viele solche Absätze rendern schnell', () => {
    for (const src of [
      '*a '.repeat(13_000),
      '_a '.repeat(13_000),
      '~a '.repeat(13_000),
      Array.from({ length: 20 }, () => '*a '.repeat(1000)).join('\n\n'),
      Array.from({ length: 200 }, () => '*a '.repeat(100) + '`c`').join(' '), // über Inline-Code verteilt
      '- ' + Array.from({ length: 3000 }, () => '**a').join(' '),
    ]) {
      const r = timed(src);
      expect(r.ms, src.slice(0, 20)).toBeLessThan(1500); // vorher 2–16 s; gemessen ~90 ms (Puffer für Last)
      expect(dom(r.html).textContent).toContain('a');
    }
    // Text bleibt sichtbar (nur ohne Hervorhebung)
    expect(dom(timed('*a '.repeat(2000)).html).textContent!.match(/\*a/g)).toHaveLength(2000);
  });

  it('normales Markdown bleibt unverändert: Hervorhebungen, lange Listen mit Fettdruck, Code mit Sternen', () => {
    const d = dom(renderMarkdown('Das ist **fett** und *kursiv* und ~~weg~~.'));
    expect(d.querySelector('strong')!.textContent).toBe('fett');
    expect(d.querySelector('em')!.textContent).toBe('kursiv');
    expect(d.querySelector('del')).not.toBeNull();
    const list = Array.from({ length: 120 }, (_, i) => `- **Begriff ${i}**: Erklärung mit *Betonung*`).join('\n');
    const l = dom(renderMarkdown(list));
    expect(l.querySelectorAll('li')).toHaveLength(120);
    expect(l.querySelectorAll('strong')).toHaveLength(120);
    const code = dom(renderMarkdown('```\n' + '*'.repeat(5000) + '\n```\n\nText `' + '_'.repeat(400) + '`'));
    expect(code.querySelector('pre code')!.textContent).toBe('*'.repeat(5000) + '\n');
    expect(code.querySelectorAll('code')[1]!.textContent).toBe('_'.repeat(400));
    // Listenzeichen bleibt Liste, auch wenn der Punkt maskiert wird
    const risky = dom(renderMarkdown('* ' + '*a '.repeat(500)));
    expect(risky.querySelectorAll('li')).toHaveLength(1);
  });
});
