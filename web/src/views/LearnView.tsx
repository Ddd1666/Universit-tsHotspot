import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { get, post } from '../api';
import { Icon } from '../components/Icon';
import { ViewHeader } from '../components/ViewHeader';
import { useApp, type GenRequest, type LearnTab } from '../store';
import type { LearnKind, LearnScope, Level, Source } from '../types';
import { CardsTab, ReviewTab, StatsTab } from './learn/Cards';
import { QuizTab } from './learn/Quiz';
import { NotesTab } from './learn/Notes';
import { GraphTab } from './learn/Graph';

const TABS: { id: LearnTab; icon: string }[] = [
  { id: 'review', icon: 'refresh' },
  { id: 'cards', icon: 'layers' },
  { id: 'quiz', icon: 'check' },
  { id: 'notes', icon: 'doc' },
  { id: 'graph', icon: 'globe' },
  { id: 'stats', icon: 'sheet' },
];

/** Lernen: Wiederholen, Karten, Quiz, Notizen, Wissensgraph, Statistik – Filter Fach (und Quelle) in der URL. */
export function LearnView({ tab, subject, source, note }: { tab: LearnTab; subject: number | null; source: number | null; note: number | null }) {
  const { t, subjects, navigate, openGenerate } = useApp();
  const go = (next: Partial<{ tab: LearnTab; subject: number | null; source: number | null; note: number | null }>) => {
    const p = { tab, subject, source, note: null as number | null, ...next };
    const q = new URLSearchParams();
    if (p.subject) q.set('subject', String(p.subject));
    if (p.source) q.set('source', String(p.source));
    if (p.note) q.set('note', String(p.note));
    navigate(`#/learn/${p.tab}${q.size ? `?${q}` : ''}`);
  };
  const onTabKey = (e: KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
    go({ tab: next.id, source: null });
    requestAnimationFrame(() => document.getElementById(`learn-tab-${next.id}`)?.focus());
  };
  return (
    <div className="view learn-view">
      <ViewHeader icon="brain" title={<h1>{t('learn.title')}</h1>}>
        <select className="input small" value={subject ?? ''} onChange={(e) => go({ subject: Number(e.target.value) || null, source: null })} aria-label={t('lib.subjects')}>
          <option value="">{t('learn.allSubjects')}</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="btn primary" onClick={() => openGenerate(subject ? { scope: { kind: 'subject', id: subject } } : {})}>
          <Icon name="spark" /> {t('learn.generate')}
        </button>
      </ViewHeader>
      <div className="learn-tabs" role="tablist" aria-label={t('learn.title')}>
        {TABS.map((x, i) => (
          <button
            key={x.id}
            id={`learn-tab-${x.id}`}
            role="tab"
            aria-selected={tab === x.id}
            tabIndex={tab === x.id ? 0 : -1}
            className={tab === x.id ? 'active' : ''}
            onClick={() => go({ tab: x.id, source: null })}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            <Icon name={x.icon} size={15} /> {t(`learn.tab.${x.id}`)}
          </button>
        ))}
      </div>
      <div className="learn-body" role="tabpanel" aria-labelledby={`learn-tab-${tab}`}>
        {tab === 'review' && <ReviewTab subject={subject} source={source} onClearSource={() => go({ source: null })} />}
        {tab === 'cards' && <CardsTab subject={subject} />}
        {tab === 'quiz' && <QuizTab subject={subject} />}
        {tab === 'notes' && <NotesTab subject={subject} noteId={note} onOpen={(id) => go({ note: id })} />}
        {tab === 'graph' && <GraphTab subject={subject} />}
        {tab === 'stats' && <StatsTab subject={subject} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Generieren-Dialog */

type ScopeKind = LearnScope['kind'];

export function GenerateDialog({ req }: { req: GenRequest }) {
  const { t, subjects, chats, openGenerate, toast, toastError } = useApp();
  const [kind, setKind] = useState<LearnKind>(req.kind ?? 'summary');
  const [scopeKind, setScopeKind] = useState<ScopeKind>(req.scope?.kind ?? 'source');
  const [sourceId, setSourceId] = useState<number | null>(req.scope?.kind === 'source' ? req.scope.id : null);
  const [heading, setHeading] = useState(req.scope?.kind === 'source' ? (req.scope.heading ?? '') : '');
  const [subjectId, setSubjectId] = useState<number | null>(req.scope?.kind === 'subject' ? req.scope.id : (subjects[0]?.id ?? null));
  const [picked, setPicked] = useState<number[]>(req.scope?.kind === 'sources' ? req.scope.ids : []);
  const [chatId, setChatId] = useState<number | null>(req.scope?.kind === 'chat' ? req.scope.id : (chats[0]?.id ?? null));
  const [level, setLevel] = useState<Level>('outline');
  const [count, setCount] = useState(20);
  const [q, setQ] = useState('');
  const [sources, setSources] = useState<Source[]>([]);
  const [sections, setSections] = useState<{ heading: string; chunks: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => boxRef.current?.querySelector<HTMLElement>('button.active, input, select')?.focus());
  }, []);
  useEffect(() => {
    if (scopeKind !== 'source' && scopeKind !== 'sources') return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      get<{ items: Source[] }>(`/api/sources?q=${encodeURIComponent(q)}`, ctrl.signal)
        .then((r) => setSources(r.items.filter((s) => (s.status === 'ready' && s.chunkCount > 0) || s.status === 'archive').slice(0, 200)))
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [scopeKind, q]);
  useEffect(() => {
    setSections([]);
    if (scopeKind !== 'source' || !sourceId) return;
    get<{ heading: string; chunks: number }[]>(`/api/learn/sections/${sourceId}`)
      .then(setSections)
      .catch(() => {});
  }, [scopeKind, sourceId]);
  // Graph nur aus Quellen
  useEffect(() => {
    if (kind === 'graph' && scopeKind === 'chat') setScopeKind('source');
  }, [kind, scopeKind]);

  const scope: LearnScope | null =
    scopeKind === 'source'
      ? sourceId
        ? { kind: 'source', id: sourceId, heading: heading || null }
        : null
      : scopeKind === 'subject'
        ? subjectId
          ? { kind: 'subject', id: subjectId }
          : null
        : scopeKind === 'sources'
          ? picked.length
            ? { kind: 'sources', ids: picked }
            : null
          : chatId
            ? { kind: 'chat', id: chatId }
            : null;

  const start = async () => {
    if (!scope) return;
    setBusy(true);
    try {
      await post('/api/learn/jobs', { kind, scope, ...(kind === 'summary' ? { level } : {}), ...(kind === 'cards' || kind === 'quiz' ? { count } : {}) });
      toast(t('learn.started'), 'success');
      openGenerate(null);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const close = () => openGenerate(null);
  const sourceOptions = sourceId && !sources.some((s) => s.id === sourceId) ? [{ id: sourceId, name: `#${sourceId}` } as Source, ...sources] : sources;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="dialog glass gen-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gen-title"
        ref={boxRef}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
          // Fokus bleibt im Dialog (wie beim Bestätigungsdialog)
          if (e.key === 'Tab' && boxRef.current) {
            const f = [...boxRef.current.querySelectorAll<HTMLElement>('button, input, select, textarea')].filter((x) => !(x as HTMLButtonElement).disabled);
            const first = f[0];
            const last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2 id="gen-title">{t('gen.title')}</h2>
        <div className="seg-field">
          <span>{t('gen.kind')}</span>
          <div className="segmented wrap" role="radiogroup" aria-label={t('gen.kind')}>
            {(['summary', 'cards', 'quiz', 'graph'] as const).map((k) => (
              <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
                {t(`gen.kind.${k}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="seg-field">
          <span>{t('gen.scope')}</span>
          <div className="segmented wrap" role="radiogroup" aria-label={t('gen.scope')}>
            {(['source', 'subject', 'sources', 'chat'] as const)
              .filter((k) => !(kind === 'graph' && k === 'chat'))
              .map((k) => (
                <button key={k} role="radio" aria-checked={scopeKind === k} className={scopeKind === k ? 'active' : ''} onClick={() => setScopeKind(k)}>
                  {t(`gen.scope.${k}`)}
                </button>
              ))}
          </div>
        </div>
        {(scopeKind === 'source' || scopeKind === 'sources') && <input className="input small" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('gen.filter')} aria-label={t('gen.filter')} />}
        {scopeKind === 'source' && (
          <div className="field-grid">
            <label className="field">
              <span>{t('gen.scope.source')}</span>
              <select value={sourceId ?? ''} onChange={(e) => (setSourceId(Number(e.target.value) || null), setHeading(''))}>
                <option value="">{t('gen.pick')}</option>
                {sourceOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            {sections.length > 0 && (
              <label className="field">
                <span>{t('gen.section')}</span>
                <select value={heading} onChange={(e) => setHeading(e.target.value)}>
                  <option value="">{t('gen.wholeSource')}</option>
                  {sections.map((s) => (
                    <option key={s.heading} value={s.heading}>
                      {s.heading}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        {scopeKind === 'subject' && (
          <label className="field">
            <span>{t('gen.scope.subject')}</span>
            <select value={subjectId ?? ''} onChange={(e) => setSubjectId(Number(e.target.value) || null)}>
              <option value="">{t('gen.pick')}</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {scopeKind === 'sources' && (
          <div className="scope-list gen-list" role="group" aria-label={t('gen.scope.sources')}>
            {sources.map((s) => (
              <label key={s.id} className="check-row">
                <input type="checkbox" checked={picked.includes(s.id)} onChange={() => setPicked((p) => (p.includes(s.id) ? p.filter((x) => x !== s.id) : [...p, s.id]))} />
                <span className="ellipsis">{s.name}</span>
              </label>
            ))}
          </div>
        )}
        {scopeKind === 'chat' && (
          <label className="field">
            <span>{t('gen.scope.chat')}</span>
            <select value={chatId ?? ''} onChange={(e) => setChatId(Number(e.target.value) || null)}>
              <option value="">{t('gen.pick')}</option>
              {chats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title || t('chats.new')}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === 'summary' && (
          <label className="field">
            <span>{t('gen.level')}</span>
            <select value={level} onChange={(e) => setLevel(e.target.value as Level)}>
              {(['tldr', 'outline', 'detailed', 'cheatsheet'] as const).map((l) => (
                <option key={l} value={l}>
                  {t(`level.${l}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        {(kind === 'cards' || kind === 'quiz') && (
          <label className="field">
            <span>{t('gen.count')}</span>
            <input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Math.min(50, Math.max(1, Number(e.target.value) || 1)))} />
          </label>
        )}
        <p className="muted small">{t('gen.hint')}</p>
        <div className="dialog-actions">
          <button className="btn ghost" onClick={close}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" onClick={() => void start()} disabled={!scope || busy}>
            <Icon name="spark" size={15} /> {t('gen.start')}
          </button>
        </div>
      </div>
    </div>
  );
}
