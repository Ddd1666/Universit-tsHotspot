import { useCallback, useEffect, useMemo, useState } from 'react';
import { del, downloadFile, get, patch, post } from '../../api';
import { Icon } from '../../components/Icon';
import { AiTag, CardFace, cardRef, RefLink } from '../../components/LearnBits';
import { formatDate } from '../../lib/format';
import { useApp, useHubEvent } from '../../store';
import type { Card, CardStatus, CardType, Source, SrsStats } from '../../types';

const qs = (o: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  return p.size ? `?${p}` : '';
};

/** Neu laden, wenn ein Lern-Job dieser Art fertig wird. */
function useJobDone(kinds: string[], fn: () => void) {
  useHubEvent((e) => {
    if (e.type === 'learn-job' && e.job.state === 'done' && kinds.includes(e.job.kind)) fn();
  });
}

const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest('.overlay'));
};

/* ------------------------------------------------------------------ Wiederholen */

const RATINGS = [
  { r: 1, key: 'review.again', cls: 'danger' },
  { r: 2, key: 'review.hard', cls: '' },
  { r: 3, key: 'review.good', cls: 'primary' },
  { r: 4, key: 'review.easy', cls: '' },
] as const;

export function ReviewTab({ subject, source, onClearSource }: { subject: number | null; source: number | null; onClearSource(): void }) {
  const { t, toastError } = useApp();
  const [queue, setQueue] = useState<Card[] | null>(null);
  const [counts, setCounts] = useState({ due: 0, fresh: 0 });
  const [done, setDone] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    get<{ items: Card[]; due: number; fresh: number }>(`/api/srs/due${qs({ subject, source })}`)
      .then((r) => {
        setQueue(r.items);
        setCounts({ due: r.due, fresh: r.fresh });
        setDone(0);
        setRevealed(false);
      })
      .catch(toastError);
  }, [subject, source, toastError]);
  useEffect(load, [load]);

  const card = queue?.[0];
  const rate = useCallback(
    async (rating: number) => {
      if (!card || busy) return;
      setBusy(true);
      try {
        const next = await post<Card>(`/api/cards/${card.id}/review`, { rating });
        // "Nochmal": kommt in dieser Sitzung noch einmal dran
        setQueue((q) => (q ? [...q.slice(1), ...(rating === 1 ? [next] : [])] : q));
        setDone((d) => d + 1);
        setRevealed(false);
      } catch (err) {
        toastError(err);
      } finally {
        setBusy(false);
      }
    },
    [card, busy, toastError],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey || !card) return;
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        void rate(Number(e.key));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, revealed, rate]);

  if (queue === null) return <p className="muted pad">{t('common.loading')}</p>;
  const total = done + queue.length;
  return (
    <div className="review">
      <div className="chip-row">
        <span className="chip">{t('review.due', counts)}</span>
        {total > 0 && <span className="chip">{t('review.progress', { done, total })}</span>}
        {source && (
          <button className="chip active" onClick={onClearSource}>
            {t('review.onlySource', { id: source })} <Icon name="close" size={12} />
          </button>
        )}
      </div>
      {!card ? (
        <div className="empty-state glass">
          <Icon name="check" size={28} />
          <p>{done ? t('review.done') : t('review.empty')}</p>
        </div>
      ) : (
        <article className="review-card glass" aria-live="polite">
          <header className="row gap">
            {card.ai && <AiTag />}
            <span className="muted small">{t(`cards.type.${card.type}`)}</span>
            <span className="spacer" />
            <RefLink r={cardRef(card)} />
          </header>
          <CardFace card={card} side={revealed ? 'back' : 'front'} />
          {!revealed ? (
            <button className="btn primary big" onClick={() => setRevealed(true)}>
              <Icon name="eye" /> {t('review.show')}
            </button>
          ) : (
            <div className="rating" role="group" aria-label={t('review.rate')}>
              {RATINGS.map((x) => (
                <button key={x.r} className={`btn ${x.cls}`} disabled={busy} onClick={() => void rate(x.r)}>
                  <kbd>{x.r}</kbd> {t(x.key)}
                </button>
              ))}
            </div>
          )}
          <p className="muted small center-text">{t('review.keys')}</p>
        </article>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Karten verwalten */

function CardEditor({ initial, subject, onDone }: { initial?: Card; subject: number | null; onDone(saved: boolean): void }) {
  const { t, toastError } = useApp();
  const [type, setType] = useState<CardType>(initial?.type ?? 'qa');
  const [front, setFront] = useState(initial?.front ?? '');
  const [back, setBack] = useState(initial?.back ?? '');
  const [sourceId, setSourceId] = useState<number | null>(initial?.sourceId ?? null);
  const [images, setImages] = useState<Source[]>([]);
  useEffect(() => {
    if (type !== 'image' || initial) return;
    get<{ items: Source[] }>('/api/sources?status=ready')
      .then((r) => setImages(r.items.filter((s) => s.kind === 'image')))
      .catch(() => {});
  }, [type, initial]);
  const save = async () => {
    try {
      if (initial) await patch(`/api/cards/${initial.id}`, { type, front, back });
      else await post('/api/cards', { type, front, back, subjectId: subject, sourceId: type === 'image' ? sourceId : null });
      onDone(true);
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <form
      className="card-editor glass"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="field-grid">
        <label className="field">
          <span>{t('cards.type')}</span>
          <select value={type} onChange={(e) => setType(e.target.value as CardType)} disabled={initial?.type === 'image'}>
            {(['qa', 'cloze', 'image'] as const).map((x) => (
              <option key={x} value={x} disabled={!!initial && x === 'image' && initial.type !== 'image'}>
                {t(`cards.type.${x}`)}
              </option>
            ))}
          </select>
        </label>
        {type === 'image' && !initial && (
          <label className="field">
            <span>{t('cards.imageSource')}</span>
            <select value={sourceId ?? ''} onChange={(e) => setSourceId(Number(e.target.value) || null)}>
              <option value="">{t('gen.pick')}</option>
              {images.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="field">
        <span>{t('cards.front')}</span>
        <textarea className="input" rows={3} maxLength={2000} value={front} onChange={(e) => setFront(e.target.value)} autoFocus />
        {type === 'cloze' && <small>{t('cards.clozeHint')}</small>}
      </label>
      <label className="field">
        <span>{t('cards.back')}</span>
        <textarea className="input" rows={3} maxLength={4000} value={back} onChange={(e) => setBack(e.target.value)} />
      </label>
      <div className="row gap">
        <button type="submit" className="btn small primary" disabled={!front.trim()}>
          {t('lib.save')}
        </button>
        <button type="button" className="btn small ghost" onClick={() => onDone(false)}>
          {t('lib.cancel')}
        </button>
      </div>
    </form>
  );
}

export function CardsTab({ subject }: { subject: number | null }) {
  const { t, lang, ask, toastError } = useApp();
  const [status, setStatus] = useState<CardStatus>('draft');
  const [data, setData] = useState<{ items: Card[]; total: number } | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | 'new' | null>(null);

  const load = useCallback(() => {
    get<{ items: Card[]; total: number }>(`/api/cards${qs({ status, subject, limit: 500 })}`)
      .then((r) => {
        setData(r);
        setSel(new Set());
      })
      .catch(toastError);
  }, [status, subject, toastError]);
  useEffect(load, [load]);
  useJobDone(['cards'], load);

  const bulk = async (ids: number[], action: 'accept' | 'discard' | 'suspend' | 'activate') => {
    try {
      await post('/api/cards/bulk', { ids, action });
      load();
    } catch (err) {
      toastError(err);
    }
  };
  const remove = async (c: Card) => {
    if ((await ask({ title: t('cards.delete'), message: t('cards.deleteConfirm'), danger: true, confirmLabel: t('common.delete') })) !== true) return;
    try {
      await del(`/api/cards/${c.id}`);
      load();
    } catch (err) {
      toastError(err);
    }
  };
  const items = data?.items ?? [];
  const allSel = items.length > 0 && items.every((c) => sel.has(c.id));

  return (
    <div className="cards-tab">
      <div className="toolbar">
        <div className="segmented" role="radiogroup" aria-label="Status">
          {(['draft', 'active', 'suspended'] as const).map((s) => (
            <button key={s} role="radio" aria-checked={status === s} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>
              {t(`cards.${s}`)}
            </button>
          ))}
        </div>
        <span className="muted small">{data ? t('cards.count', { n: data.total }) : ''}</span>
        <span className="spacer" />
        {status === 'draft' && sel.size > 0 && (
          <>
            <button className="btn small primary" onClick={() => void bulk([...sel], 'accept')}>
              <Icon name="check" size={14} /> {t('cards.acceptSel')}
            </button>
            <button className="btn small ghost" onClick={() => void bulk([...sel], 'discard')}>
              <Icon name="trash" size={14} /> {t('cards.discardSel')}
            </button>
          </>
        )}
        <button className="btn small" onClick={() => setEditing('new')}>
          <Icon name="plus" size={14} /> {t('cards.new')}
        </button>
        <button className="btn small ghost" onClick={() => void downloadFile(`/api/cards/export.csv${subject ? `?subject=${subject}` : ''}`, 'cards.csv').catch(toastError)} title={t('transfer.csvHint')}>
          <Icon name="sheet" size={14} /> {t('transfer.csv')}
        </button>
      </div>
      {status === 'draft' && items.length > 0 && (
        <div className="notice" role="note">
          <Icon name="info" size={16} /> {t('cards.draftHint')}
        </div>
      )}
      {editing === 'new' && <CardEditor subject={subject} onDone={(ok) => (setEditing(null), ok && load())} />}
      {data && items.length === 0 && <p className="muted pad">{t('cards.empty')}</p>}
      {items.length > 0 && (
        <label className="check-row small">
          <input type="checkbox" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(items.map((c) => c.id)))} />
          {t('cards.selectAll')}
        </label>
      )}
      <ul className="card-list">
        {items.map((c) =>
          editing === c.id ? (
            <li key={c.id}>
              <CardEditor initial={c} subject={subject} onDone={(ok) => (setEditing(null), ok && load())} />
            </li>
          ) : (
            <li key={c.id} className="card-row glass">
              <input
                type="checkbox"
                checked={sel.has(c.id)}
                onChange={() => setSel((s) => new Set(s.has(c.id) ? [...s].filter((x) => x !== c.id) : [...s, c.id]))}
                aria-label={t('cards.select')}
              />
              <div className="card-main">
                <div className="row gap wrap">
                  {c.ai && <AiTag />}
                  <span className="muted small">{t(`cards.type.${c.type}`)}</span>
                  <RefLink r={cardRef(c)} />
                </div>
                <CardFace card={c} side="back" />
                {c.status !== 'draft' && (
                  <span className="muted small mono">
                    {t('cards.meta', { reps: c.reviewCount, days: c.intervalDays })}
                    {c.due ? ` · ${formatDate(c.due, lang)}` : ''}
                  </span>
                )}
              </div>
              <div className="card-actions">
                {c.status === 'draft' && (
                  <button className="btn small primary" onClick={() => void bulk([c.id], 'accept')}>
                    <Icon name="check" size={14} /> {t('cards.accept')}
                  </button>
                )}
                <button className="btn small ghost" onClick={() => setEditing(c.id)}>
                  <Icon name="edit" size={14} /> {t('cards.edit')}
                </button>
                {c.status === 'draft' && (
                  <button className="btn small ghost" onClick={() => void bulk([c.id], 'discard')}>
                    <Icon name="trash" size={14} /> {t('cards.discard')}
                  </button>
                )}
                {c.status === 'active' && (
                  <button className="btn small ghost" onClick={() => void bulk([c.id], 'suspend')}>
                    {t('cards.suspend')}
                  </button>
                )}
                {c.status === 'suspended' && (
                  <button className="btn small ghost" onClick={() => void bulk([c.id], 'activate')}>
                    {t('cards.activate')}
                  </button>
                )}
                {c.status !== 'draft' && (
                  <button className="icon-btn small danger" onClick={() => void remove(c)} aria-label={t('cards.delete')} title={t('cards.delete')}>
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </div>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ Statistik */

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function StatsTab({ subject }: { subject: number | null }) {
  const { t, lang } = useApp();
  const [s, setS] = useState<SrsStats | null>(null);
  useEffect(() => {
    get<SrsStats>(`/api/srs/stats${qs({ subject })}`)
      .then(setS)
      .catch(() => {});
  }, [subject]);

  // 26 Wochen × 7 Tage, endet heute; sequentielle Skala (eine Farbe, hell -> kräftig)
  const heat = useMemo(() => {
    const by = new Map(s?.heatmap.map((h) => [h.day, h.n]) ?? []);
    const max = Math.max(1, ...by.values());
    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() - 7 * 26 + 1 - ((today.getDay() + 6) % 7));
    const days: { day: string; n: number; level: number }[] = [];
    for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const n = by.get(iso(d)) ?? 0;
      days.push({ day: iso(d), n, level: n ? Math.min(4, Math.ceil((n / max) * 4)) : 0 });
    }
    return days;
  }, [s]);
  const forecast = useMemo(() => {
    const by = new Map(s?.forecast.map((f) => [f.day, f.n]) ?? []);
    const out: { day: string; n: number }[] = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      out.push({ day: iso(d), n: by.get(iso(d)) ?? 0 });
    }
    return out;
  }, [s]);
  if (!s) return <p className="muted pad">{t('common.loading')}</p>;
  const fmtDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB', { day: '2-digit', month: 'short' });
  const maxF = Math.max(1, ...forecast.map((f) => f.n));
  const reviews = s.heatmap.reduce((n, h) => n + h.n, 0);
  return (
    <div className="stats-tab">
      <div className="stat-tiles">
        <div className="stat-tile glass">
          <span className="muted small">{t('stats.retention')}</span>
          <strong className="hero">{s.retention.rate === null ? '–' : `${Math.round(s.retention.rate * 100)} %`}</strong>
          <span className="muted small">{t('stats.reviews', { n: s.retention.total })}</span>
        </div>
        <div className="stat-tile glass">
          <span className="muted small">{t('learn.tab.review')}</span>
          <strong className="hero">{s.counts.due + s.counts.fresh}</strong>
          <span className="muted small">{t('stats.dueToday', { due: s.counts.due, fresh: s.counts.fresh })}</span>
        </div>
        <div className="stat-tile glass">
          <span className="muted small">{t('learn.tab.cards')}</span>
          <strong className="hero">{s.counts.active}</strong>
          <span className="muted small">{t('stats.cards', s.counts)}</span>
        </div>
      </div>
      <section className="glass chart-box" aria-labelledby="heat-title">
        <h3 id="heat-title">
          {t('stats.heatmap')} <span className="muted small">· {t('stats.reviews', { n: reviews })}</span>
        </h3>
        <div className="heatmap" aria-hidden="true">
          {heat.map((d) => (
            <span key={d.day} className={`heat l${d.level}`} title={t('stats.day', { day: fmtDay(d.day), n: d.n })} />
          ))}
        </div>
        <div className="heat-legend muted small" aria-hidden="true">
          {t('stats.less')} <span className="heat l0" /> <span className="heat l1" /> <span className="heat l2" /> <span className="heat l3" /> <span className="heat l4" /> {t('stats.more')}
        </div>
        <table className="sr-only">
          <caption>{t('stats.heatmap')}</caption>
          <tbody>
            {s.heatmap.map((h) => (
              <tr key={h.day}>
                <th scope="row">{fmtDay(h.day)}</th>
                <td>{h.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="glass chart-box" aria-labelledby="fc-title">
        <h3 id="fc-title">{t('stats.forecast')}</h3>
        <div className="forecast" aria-hidden="true">
          {forecast.map((f, i) => (
            <div key={f.day} className="fc-col" title={t('stats.day', { day: fmtDay(f.day), n: f.n })}>
              <span className="fc-bar" style={{ height: `${(f.n / maxF) * 100}%` }} />
              {i % 7 === 0 && <span className="fc-label muted">{fmtDay(f.day)}</span>}
            </div>
          ))}
        </div>
        <table className="sr-only">
          <caption>{t('stats.forecast')}</caption>
          <tbody>
            {forecast
              .filter((f) => f.n)
              .map((f) => (
                <tr key={f.day}>
                  <th scope="row">{fmtDay(f.day)}</th>
                  <td>{f.n}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
