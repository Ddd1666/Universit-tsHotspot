import { useEffect, useRef, useState } from 'react';
import { get } from '../api';
import { Icon } from '../components/Icon';
import { SourceDrawer } from '../components/SourceBits';
import { ViewHeader } from '../components/ViewHeader';
import { locLabel, snippetParts } from '../lib/format';
import { useApp } from '../store';
import type { SearchResult } from '../types';

export function SearchView({ initialQuery }: { initialQuery: string }) {
  const { t, subjects, navigate } = useApp();
  const [q, setQ] = useState(initialQuery);
  const [subjectIds, setSubjectIds] = useState<number[]>([]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: number; chunk: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setQ(initialQuery), [initialQuery]);
  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setResult(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      const scope = subjectIds.length ? { mode: 'subjects', ids: subjectIds } : { mode: 'all' };
      get<SearchResult>(`/api/search?q=${encodeURIComponent(query)}&limit=25&scope=${encodeURIComponent(JSON.stringify(scope))}`, ctrl.signal)
        .then((r) => {
          setResult(r);
          setError(null);
        })
        .catch((e: Error) => e.name !== 'AbortError' && setError(e.message))
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, subjectIds]);

  const toggleSubject = (id: number) => setSubjectIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  return (
    <div className={`view search-view ${preview ? 'with-panel' : ''}`}>
      <ViewHeader icon="search" title={<h1>{t('search.title')}</h1>} />
      <div className="search-wrap">
        <div className="search-box glass">
          <Icon name="search" size={20} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && navigate(`#/search?q=${encodeURIComponent(q)}`)}
            placeholder={t('search.placeholder')}
            aria-label={t('search.placeholder')}
            maxLength={500}
          />
          {loading && <span className="spinner" aria-label={t('common.loading')} />}
        </div>
        <div className="chip-row" role="group" aria-label={t('lib.subjects')}>
          <button className={`chip ${subjectIds.length === 0 ? 'active' : ''}`} onClick={() => setSubjectIds([])} aria-pressed={subjectIds.length === 0}>
            {t('search.allSubjects')}
          </button>
          {subjects.map((s) => (
            <button key={s.id} className={`chip ${subjectIds.includes(s.id) ? 'active' : ''}`} onClick={() => toggleSubject(s.id)} aria-pressed={subjectIds.includes(s.id)}>
              <span className="dot-color" style={{ background: s.color }} /> {s.name}
            </button>
          ))}
        </div>

        {!result && !error && <p className="muted center-text pad">{t('search.hint')}</p>}
        {error && <p className="err pad">{error}</p>}
        {result && (
          <>
            <div className="result-meta muted small mono">
              {t('search.results', { n: result.hits.length, mode: t(`search.mode.${result.mode}`), ms: result.tookMs })}
              {result.vectorError && <span className="warn"> · {t('chat.vectorOff')}</span>}
            </div>
            {result.hits.length === 0 && <p className="muted pad">{t('search.none')}</p>}
            <ol className="results">
              {result.hits.map((h) => (
                <li key={h.chunkId}>
                  <button className="result glass-hover" onClick={() => setPreview({ id: h.sourceId, chunk: h.chunkId })}>
                    <div className="result-head">
                      <strong className="ellipsis">{h.sourceName}</strong>
                      {locLabel(h, t) && <span className="loc">{locLabel(h, t)}</span>}
                      {h.subjectName && (
                        <span className="muted small">
                          <span className="dot-color" style={{ background: h.subjectColor ?? 'var(--accent)' }} /> {h.subjectName}
                        </span>
                      )}
                      <span className="spacer" />
                      {h.matchedBy.map((m) => (
                        <span key={m} className={`badge ${m === 'fts' ? 'muted' : 'accent'}`}>
                          {m === 'fts' ? t('search.fts') : t('search.vector')}
                        </span>
                      ))}
                    </div>
                    {h.heading && <div className="muted small ellipsis">{h.heading}</div>}
                    <p className="snippet">
                      {snippetParts(h.snippet).map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
                    </p>
                  </button>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
      {preview && <SourceDrawer sourceId={preview.id} highlightChunk={preview.chunk} onClose={() => setPreview(null)} />}
    </div>
  );
}
