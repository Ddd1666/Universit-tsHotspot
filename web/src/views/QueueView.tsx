import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post } from '../api';
import { Icon } from '../components/Icon';
import { ViewHeader } from '../components/ViewHeader';
import { formatClock, formatEta } from '../lib/format';
import { useApp, useHubEvent } from '../store';
import type { MediaJob } from '../types';

const KIND_ICON: Record<MediaJob['kind'], string> = { image: 'image', scan: 'pdf', audio: 'audio', video: 'video' };
const STATE_CLS: Record<MediaJob['state'], string> = { queued: 'muted', running: 'accent', done: 'ok', error: 'err', cancelled: 'muted' };

function progressText(j: MediaJob, t: ReturnType<typeof useApp>['t']): string | null {
  if (!j.total) return j.kind === 'audio' || j.kind === 'video' ? (j.progress ? formatClock(j.progress) : null) : null;
  if (j.kind === 'scan') return t('queue.pages', { done: j.progress, total: j.total });
  if (j.kind === 'audio' || j.kind === 'video') return t('queue.time', { done: formatClock(j.progress), total: formatClock(j.total) });
  return null;
}

/** Aufgaben-Ansicht: Medien-Jobs mit Fortschritt, Restzeit, Fehlern; Abbrechen/erneut versuchen. */
export function QueueView() {
  const { t, queue, navigate, toastError } = useApp();
  const [jobs, setJobs] = useState<MediaJob[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    void get<{ jobs: MediaJob[] }>('/api/jobs')
      .then((r) => setJobs(r.jobs))
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  useHubEvent((e) => {
    if (e.type === 'job') setJobs((js) => (js ? js.map((j) => (j.id === e.job.id ? e.job : j)) : js));
    // neue/entfernte Jobs: Liste gebündelt neu laden
    if (e.type === 'jobs' || e.type === 'source-deleted') {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 300);
    }
  });

  const act = async (j: MediaJob, what: 'cancel' | 'retry') => {
    try {
      await post(`/api/jobs/${j.id}/${what}`);
      load();
    } catch (err) {
      toastError(err);
    }
  };

  const active = jobs?.filter((j) => j.state === 'running' || j.state === 'queued') ?? [];
  // Restzeit veraltet ohne neue Ereignisse (z. B. langes Segment): solange etwas läuft, alle 10 s auffrischen
  const running = active.some((j) => j.state === 'running');
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(load, 10_000);
    return () => clearInterval(iv);
  }, [running, load]);
  const rest = jobs?.filter((j) => j.state !== 'running' && j.state !== 'queued') ?? [];
  const e = queue.embed;

  const row = (j: MediaJob) => {
    const pct = j.total ? Math.min(100, Math.round((j.progress / j.total) * 100)) : null;
    const prog = progressText(j, t);
    const detailKey = `detail.${j.detail}` as 'detail.no_text';
    const detail = j.detail ? (t(detailKey) === detailKey ? j.detail : t(detailKey)) : null;
    return (
      <li key={j.id} className={`job glass ${j.state}`}>
        <span className={`kind kind-${KIND_ICON[j.kind]}`} aria-hidden="true">
          <Icon name={KIND_ICON[j.kind]} size={16} />
        </span>
        <div className="job-main">
          <div className="job-head">
            <button className="link ellipsis job-name" onClick={() => navigate(`#/library/all?source=${j.sourceId}`)} title={t('queue.open')}>
              {j.sourceName}
            </button>
            <span className="muted small">{t(`queue.kind.${j.kind}`)}</span>
            <span className={`badge ${STATE_CLS[j.state]}`}>
              {j.state === 'running' && <span className="spinner tiny" aria-hidden="true" />}
              {t(`queue.state.${j.state}`)}
            </span>
          </div>
          {(j.state === 'running' || (j.state === 'queued' && j.progress > 0)) && (
            <div className="job-progress">
              {pct !== null && (
                <div className="mini-bar wide" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={j.sourceName}>
                  <span style={{ width: `${pct}%` }} />
                </div>
              )}
              <span className="muted small mono">
                {[prog, j.etaSec !== null ? t('queue.eta', { eta: formatEta(j.etaSec) }) : null].filter(Boolean).join(' · ')}
              </span>
              {j.note && <span className="warn small">{t(`queue.note.${j.note}`)}</span>}
            </div>
          )}
          {detail && j.state === 'error' && (
            <p className="err small" role="note">
              <Icon name="alert" size={13} /> {detail}
            </p>
          )}
        </div>
        <div className="job-actions">
          {(j.state === 'running' || j.state === 'queued') && (
            <button className="btn small ghost" onClick={() => void act(j, 'cancel')}>
              <Icon name="stop" size={14} /> {t('queue.cancel')}
            </button>
          )}
          {(j.state === 'error' || j.state === 'cancelled') && (
            <button className="btn small" onClick={() => void act(j, 'retry')}>
              <Icon name="refresh" size={14} /> {t('queue.retry')}
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="view queue-view">
      <ViewHeader icon="cpu" title={<h1>{t('queue.title')}</h1>} />
      <div className="queue-wrap">
        <p className="muted">{t('queue.subtitle')}</p>
        <div className="notice" role="note">
          <Icon name="info" size={16} /> {t('queue.priority')}
        </div>
        <div className="chip-row">
          <span className="chip">{t('queue.active', { n: active.length })}</span>
          <span className="chip">{t('queue.embed', { pending: e.pending })}</span>
          <span className="chip">{t('queue.ingest', { n: queue.ingest.queued + queue.ingest.processing.length })}</span>
        </div>
        {jobs === null && <p className="muted">{t('common.loading')}</p>}
        {jobs?.length === 0 && <p className="muted pad">{t('queue.empty')}</p>}
        {active.length > 0 && <ul className="job-list">{active.map(row)}</ul>}
        {rest.length > 0 && <ul className="job-list done">{rest.map(row)}</ul>}
      </div>
    </div>
  );
}
