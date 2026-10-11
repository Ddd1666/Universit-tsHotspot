import { useEffect, useState } from 'react';
import { fileUrl, get } from '../api';
import { apiErrorText } from '../lib/errors';
import { formatBytes, formatDate, kindIcon, locLabel } from '../lib/format';
import { sourceBadge } from '../lib/status';
import { useApp } from '../store';
import type { ChunkPreview, Source } from '../types';
import { Icon } from './Icon';

export function StatusBadge({ source }: { source: Source }) {
  const { t } = useApp();
  const s = source.status;
  const { key, cls } = sourceBadge(source);
  const detail = statusDetailText(source, t);
  return (
    <span className={`badge ${cls}`} title={detail || undefined}>
      {(s === 'processing' || s === 'queued') && <span className="spinner tiny" aria-hidden="true" />}
      {t(key)}
    </span>
  );
}

export function statusDetailText(source: Source, t: ReturnType<typeof useApp>['t']): string | null {
  if (!source.statusDetail) return null;
  if (source.status === 'archive') {
    try {
      const s = JSON.parse(source.statusDetail) as { files: number; duplicates: number; skipped: number };
      return t('lib.archiveSummary', s);
    } catch {
      return null;
    }
  }
  if (source.status === 'error') {
    const key = `detail.${source.statusDetail}` as 'detail.no_text';
    const v = t(key);
    return v === key ? source.statusDetail : v;
  }
  return source.statusDetail
    .split(',')
    .map((p) => {
      const key = `detail.${p}` as 'detail.no_text';
      const v = t(key);
      return v === key ? p : v;
    })
    .join(' · ');
}

export function KindIcon({ kind }: { kind: string }) {
  return (
    <span className={`kind kind-${kindIcon(kind)}`} aria-hidden="true">
      <Icon name={kindIcon(kind)} size={16} />
    </span>
  );
}

/** Seitliches Vorschau-Panel für eine Quelle: Metadaten, Aktionen, extrahierte Abschnitte. */
export function SourceDrawer({ sourceId, highlightChunk, onClose, actions }: { sourceId: number; highlightChunk?: number | null; onClose(): void; actions?: (s: Source) => React.ReactNode }) {
  const { t, lang, subjects } = useApp();
  const [data, setData] = useState<{ source: Source; chunks: ChunkPreview[]; children: Source[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    const ctrl = new AbortController();
    get<{ source: Source; chunks: ChunkPreview[]; children: Source[] }>(`/api/sources/${sourceId}${highlightChunk ? `?around=${highlightChunk}` : ''}`, ctrl.signal)
      .then(setData)
      .catch((e: Error & { code?: string }) => {
        if (e.name !== 'AbortError') setError(e.code === 'not_found' ? t('src.deleted') : apiErrorText(t, e));
      });
    return () => ctrl.abort();
  }, [sourceId, highlightChunk, t]);

  useEffect(() => {
    if (!data || !highlightChunk) return;
    document.getElementById(`chunk-${highlightChunk}`)?.scrollIntoView({ block: 'center' });
  }, [data, highlightChunk]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const s = data?.source;
  const subject = s ? subjects.find((x) => x.id === s.subjectId) : null;
  return (
    <aside className="drawer glass" aria-label={t('lib.preview')}>
      <header className="drawer-head">
        {s && <KindIcon kind={s.kind} />}
        <h2 title={s?.name}>{s?.name ?? t('common.loading')}</h2>
        <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
          <Icon name="close" />
        </button>
      </header>
      {error && <p className="err pad">{error}</p>}
      {s && (
        <div className="drawer-body">
          <div className="drawer-actions">
            <a className="btn small" href={fileUrl(s.id)} target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={15} /> {t('src.open')}
            </a>
            <a className="btn small" href={fileUrl(s.id, true)} download>
              <Icon name="download" size={15} /> {t('src.download')}
            </a>
            {actions?.(s)}
          </div>
          <dl className="meta-grid">
            <dt>{t('lib.type')}</dt>
            <dd>
              {s.kind.toUpperCase()} <span className="muted">· {s.mime}</span>
            </dd>
            <dt>{t('lib.size')}</dt>
            <dd>{formatBytes(s.size, lang)}</dd>
            <dt>{t('lib.imported')}</dt>
            <dd>{formatDate(s.importedAt, lang)}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge source={s} /> {statusDetailText(s, t) && <span className="muted small">{statusDetailText(s, t)}</span>}
            </dd>
            {subject && (
              <>
                <dt>{t('lib.subjects')}</dt>
                <dd>
                  <span className="dot-color" style={{ background: subject.color }} /> {subject.name}
                </dd>
              </>
            )}
            {s.relPath && (
              <>
                <dt>{t('lib.path')}</dt>
                <dd className="mono small">{s.relPath}</dd>
              </>
            )}
            <dt>{t('lib.hash')}</dt>
            <dd className="mono small" title={s.sha256}>
              {s.sha256.slice(0, 16)}…
            </dd>
            {s.chunkCount > 0 && (
              <>
                <dt>Index</dt>
                <dd>
                  {t('lib.chunks', { n: s.chunkCount })} · {t('lib.vectors', { done: s.embeddedCount, total: s.chunkCount })}
                </dd>
              </>
            )}
          </dl>
          {data.children.length > 0 && (
            <>
              <h3>{t('lib.children')}</h3>
              <ul className="child-list">
                {data.children.map((c) => (
                  <li key={c.id}>
                    <KindIcon kind={c.kind} />
                    <span className="ellipsis">{c.relPath ?? c.name}</span>
                    <StatusBadge source={c} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {s.status !== 'archive' && (
            <>
              <h3>{t('lib.extracted')}</h3>
              {data.chunks.length === 0 && <p className="muted">{t('lib.noChunks')}</p>}
              <ol className="chunk-list">
                {data.chunks.map((c) => (
                  <li key={c.id} id={`chunk-${c.id}`} className={c.id === highlightChunk ? 'highlight' : ''}>
                    <div className="chunk-meta">
                      {locLabel(c, t) && <span className="loc">{locLabel(c, t)}</span>}
                      {c.heading && <span className="muted ellipsis">{c.heading}</span>}
                    </div>
                    <p>{c.text.length > 1200 ? c.text.slice(0, 1200) + ' …' : c.text}</p>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
