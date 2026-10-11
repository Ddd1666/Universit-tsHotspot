import { useSyncExternalStore } from 'react';
import { formatBytes } from '../lib/format';
import { isItemFinished, type ImportItem } from '../lib/importer';
import { useApp } from '../store';
import { Icon } from './Icon';

function itemState(i: ImportItem, t: ReturnType<typeof useApp>['t']): { label: string; cls: string } {
  switch (i.status) {
    case 'waiting':
      return { label: t('import.waiting'), cls: 'muted' };
    case 'uploading':
      return { label: `${t('import.uploading')} ${Math.round(i.progress * 100)} %`, cls: 'accent' };
    case 'duplicate':
      return { label: t('import.duplicate'), cls: 'warn' };
    case 'error':
      return { label: `${t('import.error')}: ${i.error ?? ''}`, cls: 'err' };
    case 'cancelled':
      return { label: t('import.cancelled'), cls: 'muted' };
    case 'stored': {
      const s = i.serverStatus;
      if (!s) return { label: t('import.stored'), cls: 'ok' };
      const label = t(`status.${s}` as 'status.ready');
      return { label, cls: s === 'error' ? 'err' : s === 'ready' || s === 'archive' ? 'ok' : s === 'unsupported' ? 'warn' : 'accent' };
    }
  }
}

/** Schwebendes Import-Panel mit Fortschritt pro Datei (bleibt beim Ansichtswechsel sichtbar). */
export function ImportPanel() {
  const { importer, t } = useApp();
  const snap = useSyncExternalStore(importer.subscribe, importer.getSnapshot);
  if (!snap.items.length) return null;
  const done = snap.items.filter((i) => i.status !== 'waiting' && i.status !== 'uploading').length;
  const finished = snap.items.filter(isItemFinished).length;
  const pct = Math.round((finished / snap.items.length) * 100);
  return (
    <section className="import-panel glass" aria-label={t('import.title')}>
      <header>
        <Icon name="upload" />
        <strong>{t('import.title')}</strong>
        <span className="muted small">{t('import.progress', { done, total: snap.items.length })}</span>
        <span className="spacer" />
        {snap.active ? (
          <button className="btn small danger" onClick={() => importer.cancel()}>
            {t('import.cancel')}
          </button>
        ) : (
          <>
            <button className="btn small ghost" onClick={() => importer.clearFinished()}>
              {t('import.clear')}
            </button>
            <button className="icon-btn small" onClick={() => importer.clearAll()} aria-label={t('import.close')}>
              <Icon name="close" size={14} />
            </button>
          </>
        )}
      </header>
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {snap.skippedHidden > 0 && <p className="muted small pad-x">{t('import.skippedHidden', { n: snap.skippedHidden })}</p>}
      <ul className="import-list">
        {snap.items.slice(-200).map((i) => {
          const st = itemState(i, t);
          return (
            <li key={i.key}>
              <span className="import-name" title={i.relPath ?? i.name}>
                {i.name}
              </span>
              <span className="muted small">{formatBytes(i.size)}</span>
              <span className={`import-state ${st.cls}`}>{st.label}</span>
              {i.status === 'uploading' && (
                <div className="progress thin">
                  <span style={{ width: `${Math.round(i.progress * 100)}%` }} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
