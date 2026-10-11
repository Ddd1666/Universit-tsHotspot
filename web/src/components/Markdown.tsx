import { memo, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { ensureKatex, hasMath, katexLoaded, renderMarkdown } from '../lib/markdown';

interface Props {
  text: string;
  maxCite?: number;
  onCite?: (n: number) => void;
  streaming?: boolean;
}

/** Rendert Markdown über den Sanitizer (DOMPurify) – nie ungefiltertes HTML. */
export const Markdown = memo(function Markdown({ text, maxCite = 0, onCite, streaming }: Props) {
  const [katexReady, setKatexReady] = useState(katexLoaded());
  const needsMath = useMemo(() => hasMath(text), [text]);
  useEffect(() => {
    if (needsMath && !katexReady) void ensureKatex().then(() => setKatexReady(true));
  }, [needsMath, katexReady]);
  const html = useMemo(() => renderMarkdown(text, { maxCite }), [text, maxCite, katexReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest('button.cite');
    if (btn && onCite) onCite(Number(btn.getAttribute('data-cite')));
  };
  return <div className={streaming ? 'md streaming' : 'md'} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
