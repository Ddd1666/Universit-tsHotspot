import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { downloadFile, get, post } from '../api';
import { CopyCmd } from '../components/CopyCmd';
import { Icon } from '../components/Icon';
import { ViewHeader } from '../components/ViewHeader';
import { formatBytes, formatDate } from '../lib/format';
import { useApp } from '../store';
import type { Diagnostics } from '../types';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** Diagnose: Versionen, Ollama, Werkzeuge, Datenordner, Sicherungen; Bericht ohne Dokumentinhalte herunterladen. */
export function DiagnosticsView() {
  const { t, lang, toastError, setWizardOpen, navigate } = useApp();
  const [d, setD] = useState<Diagnostics | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      await post('/api/ollama/refresh').catch(() => {});
      setD(await get<Diagnostics>('/api/diagnostics'));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }, [toastError]);
  useEffect(() => void load(), [load]);

  const yes = (ok: boolean | null, okText = t('diag.ok'), bad = t('diag.problem')) => <span className={`badge ${ok ? 'ok' : ok === null ? 'muted' : 'warn'}`}>{ok ? okText : bad}</span>;

  return (
    <div className="view diag-view">
      <ViewHeader icon="pulse" title={<h1>{t('diag.title')}</h1>}>
        <button className="btn" onClick={() => void load()} disabled={busy}>
          <Icon name="refresh" /> {t('wiz.recheck')}
        </button>
        <button className="btn primary" onClick={() => void downloadFile('/api/diagnostics/report', 'diagnose.txt').catch(toastError)}>
          <Icon name="download" /> {t('diag.report')}
        </button>
      </ViewHeader>
      {!d ? (
        <div className="skeleton-list pad" aria-hidden="true">
          <div />
          <div />
        </div>
      ) : (
        <div className="settings-grid">
          <p className="muted small wide">{t('diag.privacy')}</p>
          <section className="settings-section glass" aria-labelledby="dg-app">
            <h2 id="dg-app">
              <Icon name="info" /> {t('diag.app')}
            </h2>
            <dl className="kv">
              <Row label="Uni-Hotspot">
                v{d.app.version} · Schema {d.app.schema} {d.app.mock && <span className="badge warn">MOCK</span>}
              </Row>
              <Row label={t('diag.platform')}>{d.app.platform}</Row>
              <Row label="Node.js">{d.app.node}</Row>
              <Row label="Electron">{d.app.electron ?? t('diag.browserMode')}</Row>
              <Row label="SQLite">{d.app.sqlite}</Row>
              <Row label={t('diag.memory')}>{t('diag.memoryVal', { rss: formatBytes(d.app.rssBytes, lang), cache: formatBytes(d.app.vectorCacheBytes, lang) })}</Row>
              <Row label={t('diag.uptime')}>{t('diag.minutes', { n: Math.round(d.app.uptimeSec / 60) })}</Row>
            </dl>
          </section>

          <section className="settings-section glass" aria-labelledby="dg-ollama">
            <h2 id="dg-ollama">
              <Icon name="cpu" /> Ollama
            </h2>
            <dl className="kv">
              <Row label={t('diag.status')}>{yes(d.ollama.reachable, t('set.reachable'), t('set.unreachable'))}</Row>
              <Row label={t('set.version')}>{d.ollama.version ?? '–'}</Row>
              <Row label="URL">
                <span className="mono">{d.ollama.url}</span>
              </Row>
              <Row label={t('diag.models')}>{d.ollama.models}</Row>
              {d.ollama.running.length > 0 && <Row label={t('set.running')}>{d.ollama.running.map((r) => `${r.name} (${t('set.gpu', { p: r.gpuPercent })})`).join(', ')}</Row>}
            </dl>
            <h3>{t('wiz.models')}</h3>
            <ul className="wiz-checks">
              {d.ollama.required.map((r) => (
                <li key={r.model}>
                  <div className="row gap wrap">
                    <strong>{r.roles.map((x) => t(`wiz.role.${x}`)).join(' + ')}</strong>
                    <span className="mono">{r.model}</span>
                    <span className="spacer" />
                    {yes(r.installed, t('wiz.installed'), r.installed === null ? t('wiz.unknown') : t('wiz.missing'))}
                  </div>
                  {r.installed === false && <CopyCmd cmd={`ollama pull ${r.model}`} />}
                </li>
              ))}
            </ul>
            {d.ollama.error && <p className="warn small mono">{d.ollama.error}</p>}
          </section>

          <section className="settings-section glass" aria-labelledby="dg-tools">
            <h2 id="dg-tools">
              <Icon name="audio" /> {t('diag.tools')}
            </h2>
            <dl className="kv">
              <Row label="ffmpeg">{yes(d.tools.ffmpeg, t('wiz.installed'), t('wiz.optionalMissing'))}</Row>
              <Row label="whisper.cpp">{yes(d.tools.whisper, t('wiz.installed'), t('wiz.optionalMissing'))}</Row>
              <Row label={t('diag.whisperModels')}>{d.tools.whisperModels.join(', ') || '–'}</Row>
            </dl>
          </section>

          <section className="settings-section glass" aria-labelledby="dg-data">
            <h2 id="dg-data">
              <Icon name="folder" /> {t('set.data')}
            </h2>
            <CopyCmd cmd={d.dataDir.path} wrap />
            <dl className="kv">
              <Row label={t('diag.writable')}>{yes(d.dataDir.writable)}</Row>
              <Row label={t('diag.free')}>{d.dataDir.freeBytes !== null ? formatBytes(d.dataDir.freeBytes, lang) : '–'}</Row>
              <Row label={t('diag.db')}>{formatBytes(d.dataDir.sizes.db, lang)}</Row>
              <Row label={t('diag.files')}>{t('diag.filesVal', { n: d.dataDir.fileCount, size: formatBytes(d.dataDir.sizes.files, lang) })}</Row>
              <Row label={t('diag.backups')}>{formatBytes(d.dataDir.sizes.backups, lang)}</Row>
              <Row label={t('diag.logs')}>{formatBytes(d.dataDir.sizes.logs, lang)}</Row>
              {d.counts && <Row label={t('diag.content')}>{t('set.stats', { sources: d.counts.sources, chunks: d.counts.chunks, vectors: d.counts.vectors, size: formatBytes(d.counts.bytes, lang) })}</Row>}
            </dl>
            {d.dataDir.synced && (
              <p className="notice warn" role="note">
                <Icon name="alert" size={16} /> {t('wiz.synced')}
              </p>
            )}
          </section>

          <section className="settings-section glass" aria-labelledby="dg-backup">
            <h2 id="dg-backup">
              <Icon name="shield" /> {t('backup.title')}
            </h2>
            <dl className="kv">
              <Row label={t('diag.lastBackup')}>{d.backups.last ? formatDate(d.backups.last, lang) : t('diag.never')}</Row>
              <Row label={t('diag.backupCount')}>{d.backups.count}</Row>
              <Row label={t('backup.interval')}>{d.backups.intervalHours ? t('backup.everyHours', { n: d.backups.intervalHours }) : t('backup.off')}</Row>
            </dl>
            <div className="row gap wrap">
              <button className="btn small" onClick={() => navigate('#/backup')}>
                <Icon name="shield" size={14} /> {t('backup.open')}
              </button>
              <button className="btn small ghost" onClick={() => setWizardOpen(true)}>
                <Icon name="spark" size={14} /> {t('wiz.open')}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
