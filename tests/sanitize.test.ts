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
