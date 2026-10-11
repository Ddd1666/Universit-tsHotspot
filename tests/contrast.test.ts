import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../server/config.ts';

/** WCAG-AA-Kontrast (≥ 4,5:1) der Design-Tokens für Text auf den verwendeten Hintergründen. */
const css = fs.readFileSync(path.join(PROJECT_ROOT, 'web', 'src', 'styles.css'), 'utf8');

function block(selectorStart: string): Record<string, string> {
  const i = css.indexOf(selectorStart);
  const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[m[1]!] = m[2]!.trim();
  return vars;
}

type RGB = [number, number, number];
function parse(c: string): { rgb: RGB; a: number } {
  if (c.startsWith('#')) return { rgb: [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as RGB, a: 1 };
  const m = /rgba?\(([^)]+)\)/.exec(c)!;
  const p = m[1]!.split(',').map((x) => Number(x.trim()));
  return { rgb: [p[0]!, p[1]!, p[2]!], a: p[3] ?? 1 };
}
const over = (fg: string, bg: RGB): RGB => {
  const { rgb, a } = parse(fg);
  return rgb.map((v, i) => v * a + bg[i]! * (1 - a)) as RGB;
};
const lum = (rgb: RGB) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe('Kontrast der Farbschemata (WCAG AA)', () => {
  for (const [name, sel] of [
    ['dunkel', ":root,\n[data-theme='dark']"],
    ['hell', "[data-theme='light'] {"],
  ] as const) {
    it(name, () => {
      const v = block(sel);
      const bg = parse(v.bg!).rgb;
      const backgrounds: Record<string, RGB> = {
        bg,
        'surface-solid': parse(v['surface-solid']!).rgb,
        surface: over(v.surface!, bg),
        'surface-2': over(v['surface-2']!, bg),
        'surface-3': over(v['surface-3']!, bg),
        'code-bg': over(v['code-bg']!, parse(v['surface-solid']!).rgb),
      };
      const accentSoft = over(`rgba(${parse(v.accent!).rgb.join(',')},0.16)`, bg);
      backgrounds['accent-soft'] = accentSoft;
      for (const fg of ['text', 'text-dim', 'text-faint', 'accent']) {
        for (const [bgName, bgRgb] of Object.entries(backgrounds)) {
          const r = ratio(parse(v[fg]!).rgb, bgRgb);
          expect(r, `${name}: --${fg} auf ${bgName} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});
