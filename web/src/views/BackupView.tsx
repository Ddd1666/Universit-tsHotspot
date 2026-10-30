import { useCallback, useEffect, useRef, useState } from 'react';
import { del, downloadFile, exportUrl, get, post, uploadRaw, waitForServer } from '../api';
import { CopyCmd } from '../components/CopyCmd';
import { Icon } from '../components/Icon';
import { ViewHeader } from '../components/ViewHeader';
import { formatBytes, formatDate } from '../lib/format';
import { useApp } from '../store';
import type { BackupState, ImportReport, Snapshot } from '../types';

const INTERVALS = [0, 6, 12, 24, 72, 168];

/** Sicherung & Wiederherstellung, Export/Import einer Bibliothek bzw. eines Fachs, Karteikarten-CSV. */
export function BackupView() {
  const { t, lang, subjects, settings, updateSettings, ask, toast, toastError } = useApp();
  const [state, setState] = useState<BackupState | null>(null);
  const [working, setWorking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [dir, setDir] = useState(settings.backupDir);
  const [scope, setScope] = useState<'all' | number>('all');
  const [upload, setUpload] = useState<number | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    get<BackupState>('/api/backups').then(setState).catch(toastError);
  }, [toastError]);
  useEffect(load, [load]);
  useEffect(() => setDir(settings.backupDir), [settings.backupDir]);

  const backupNow = async () => {
    setWorking(true);
    try {
      setState(await post<BackupState>('/api/backups'));
      toast(t('backup.done'), 'success');
    } catch (err) {
      toastError(err);
    } finally {
      setWorking(false);
    }
  };

  const restore = async (s: Snapshot) => {
    const ok = await ask({ title: t('backup.restore'), message: t('backup.restoreConfirm', { date: formatDate(s.createdAt, lang) }), danger: true, confirmLabel: t('backup.restore') });
    if (ok !== true) return;
    setWorking(true);
    try {
      const r = await post<{ restarting: boolean; missingFiles: number; preRestore: string }>(`/api/backups/${encodeURIComponent(s.id)}/restore`, { confirm: true });
      if (r.missingFiles) toast(t('backup.missingFiles', { n: r.missingFiles }), 'error');
      if (r.restarting) {
        setRestarting(true);
        await waitForServer();
        location.reload();
      } else {
        toast(t('backup.restartNeeded'), 'info');
        load();
      }
    } catch (err) {
      toastError(err);
    } finally {
      setWorking(false);
    }
  };

  const remove = async (s: Snapshot) => {
    if ((await ask({ title: t('backup.delete'), message: t('backup.deleteConfirm', { date: formatDate(s.createdAt, lang) }), danger: true, confirmLabel: t('common.delete') })) !== true) return;
    try {
      setState(await del<BackupState>(`/api/backups/${encodeURIComponent(s.id)}`));
    } catch (err) {
      toastError(err);
    }
  };

  const saveDir = async (value: string) => {
    try {
      await updateSettings({ backupDir: value });
      load();
      toast(t('set.saved'), 'success');
    } catch {
      /* Toast kommt aus updateSettings */
    }
  };

  const importFile = async (file: File) => {
    setReport(null);
    setUpload(0);
    try {
      setReport(await uploadRaw<ImportReport>('/api/library/import', file, setUpload));
      toast(t('transfer.imported'), 'success');
    } catch (err) {
      toastError(err);
    } finally {
      setUpload(null);
    }
  };

  if (restarting) {
    return (
      <div className="view">
        <div className="empty-state" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <strong>{t('backup.restarting')}</strong>
          <span className="muted small">{t('backup.restartingText')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="view backup-view">
      <ViewHeader icon="shield" title={<h1>{t('backup.title')}</h1>}>
        <button className="btn primary" onClick={() => void backupNow()} disabled={working || state?.busy}>
          <Icon name="shield" /> {t('backup.now')}
        </button>
      </ViewHeader>
      <div className="settings-grid">
        <section className="settings-section glass wide" aria-labelledby="bk-list">
          <h2 id="bk-list">
            <Icon name="clock" /> {t('backup.list')}
          </h2>
          {state?.busy && (
            <p className="muted small" role="status">
              <span className="spinner" aria-hidden="true" /> {t('backup.running')}
            </p>
          )}
          {state && state.items.length === 0 && <p className="muted">{t('backup.empty')}</p>}
          {state && state.items.length > 0 && (
            <ul className="snapshot-list">
              {state.items.map((s) => (
                <li key={s.id} className="snapshot-row">
                  <div className="snap-main">
                    <strong>{formatDate(s.createdAt, lang)}</strong>
                    <span className={`badge ${s.reason === 'manual' ? 'accent' : s.reason === 'pre-restore' ? 'warn' : 'muted'}`}>{t(`backup.reason.${s.reason}`)}</span>
                    <span className="muted small">
                      {t('backup.meta', { files: s.files, size: formatBytes(s.bytes + s.dbBytes, lang) })}
                      {s.schemaVersion !== null ? ` · v${s.appVersion ?? '?'} / Schema ${s.schemaVersion}` : ''}
                    </span>
                    {s.missing > 0 && <span className="warn small">{t('backup.missing', { n: s.missing })}</span>}
                  </div>
                  <div className="row gap">
                    <button className="btn small" onClick={() => void restore(s)} disabled={working || state.busy} aria-label={`${t('backup.restore')}: ${formatDate(s.createdAt, lang)}`}>
                      <Icon name="refresh" size={14} /> {t('backup.restore')}
                    </button>
                    <button className="icon-btn small danger" onClick={() => void remove(s)} aria-label={`${t('backup.delete')}: ${formatDate(s.createdAt, lang)}`} title={t('backup.delete')}>
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">{t('backup.how')}</p>
        </section>

        <section className="settings-section glass" aria-labelledby="bk-auto">
          <h2 id="bk-auto">
            <Icon name="settings" /> {t('backup.auto')}
          </h2>
          <label className="field">
            <span>{t('backup.interval')}</span>
            <select className="input" value={settings.backupIntervalHours} onChange={(e) => void updateSettings({ backupIntervalHours: Number(e.target.value) }).then(load)}>
              {[...new Set([...INTERVALS, settings.backupIntervalHours])].map((h) => (
                <option key={h} value={h}>
                  {h === 0 ? t('backup.off') : h % 24 === 0 ? t('backup.everyDays', { n: h / 24 }) : t('backup.everyHours', { n: h })}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('backup.keep')}</span>
            <select className="input" value={settings.backupKeep} onChange={(e) => void updateSettings({ backupKeep: Number(e.target.value) })}>
              {[...new Set([3, 5, 7, 14, 30, settings.backupKeep])].sort((a, b) => a - b).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <small className="muted">{t('backup.keepHint')}</small>
          </label>
          <label className="field">
            <span>{t('backup.dir')}</span>
            {state && <CopyCmd cmd={state.dir} />}
            <div className="row gap">
              <input className="input mono" value={dir} onChange={(e) => setDir(e.target.value)} placeholder={state?.defaultDir ?? ''} aria-label={t('backup.dirChange')} />
              <button className="btn small" disabled={dir.trim() === settings.backupDir} onClick={() => void saveDir(dir.trim())}>
                {t('lib.save')}
              </button>
            </div>
            <small className="muted">{t('backup.dirHint')}</small>
          </label>
        </section>

        <section className="settings-section glass" aria-labelledby="bk-transfer">
          <h2 id="bk-transfer">
            <Icon name="archive" /> {t('transfer.title')}
          </h2>
          <p className="muted small">{t('transfer.text')}</p>
          <label className="field">
            <span>{t('transfer.scope')}</span>
            <div className="row gap wrap">
              <select className="input" value={String(scope)} onChange={(e) => setScope(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
                <option value="all">{t('transfer.all')}</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <a className="btn small primary" href={exportUrl(scope)} download>
                <Icon name="download" size={14} /> {t('transfer.export')}
              </a>
            </div>
          </label>
          <div className="field">
            <span>{t('transfer.import')}</span>
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void importFile(f);
              }}
            />
            <button className="btn small" onClick={() => fileRef.current?.click()} disabled={upload !== null}>
              <Icon name="upload" size={14} /> {t('transfer.pick')}
            </button>
            {upload !== null && (
              <div className="mini-bar wide" role="progressbar" aria-label={t('transfer.uploading')} aria-valuenow={Math.round(upload * 100)} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${Math.round(upload * 100)}%` }} />
              </div>
            )}
            <small className="muted">{t('transfer.importHint')}</small>
          </div>
          {report && (
            <div className="index-box" role="status">
              <strong>{t('transfer.report')}</strong>
              <ul className="report-list small">
                <li>{t('transfer.rSubjects', { created: report.subjects.created, merged: report.subjects.merged })}</li>
                <li>{t('transfer.rSources', { added: report.sources.added, dup: report.sources.duplicate, skipped: report.sources.skipped + report.files.invalid })}</li>
                <li>{t('transfer.rLearn', { cards: report.cards.added, notes: report.notes.added, questions: report.questions.added })}</li>
                {report.sources.requeued > 0 && <li>{t('transfer.rRequeued', { n: report.sources.requeued })}</li>}
                {report.skippedRecords > 0 && <li className="warn">{t('transfer.rSkipped', { n: report.skippedRecords })}</li>}
              </ul>
            </div>
          )}
          <h3>{t('transfer.cards')}</h3>
          <button className="btn small" onClick={() => void downloadFile('/api/cards/export.csv', 'cards.csv').catch(toastError)}>
            <Icon name="sheet" size={14} /> {t('transfer.csv')}
          </button>
          <small className="muted">{t('transfer.csvHint')}</small>
        </section>
      </div>
    </div>
  );
}
