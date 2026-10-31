import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { del, get, patch, post } from '../api';
import { Icon } from '../components/Icon';
import { ImportPanel } from '../components/ImportPanel';
import { KindIcon, SourceDrawer, StatusBadge, statusDetailText } from '../components/SourceBits';
import { ViewHeader } from '../components/ViewHeader';
import { formatBytes, formatDate, SUBJECT_COLORS } from '../lib/format';
import { collectDropped, fromInput } from '../lib/importer';
import { useApp, useHubEvent } from '../store';
import type { Source, Subject } from '../types';

const PAGE = 200;
/** Abstand zwischen Zeilen (CSS .source-list gap) und Puffer-Zeilen ober-/unterhalb des Sichtbereichs */
const ROW_GAP = 6;
const OVERSCAN = 15;

/** Fach-Auswahl je Zeile: Optionen erst beim Öffnen rendern (sonst Zeilen × Fächer DOM-Knoten). */
function MoveSelect({ s, subjects, label, noSubject, onMove }: { s: Source; subjects: Subject[]; label: string; noSubject: string; onMove(id: string): void }) {
  const [open, setOpen] = useState(false);
  const cur = subjects.find((x) => x.id === s.subjectId);
  return (
    <select className="move-select" value={s.subjectId ?? ''} onFocus={() => setOpen(true)} onPointerDown={() => setOpen(true)} onChange={(e) => onMove(e.target.value)} aria-label={label} title={label}>
      <option value="">{noSubject}</option>
      {open
        ? subjects.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))
        : cur && <option value={cur.id}>{cur.name}</option>}
    </select>
  );
}

function SubjectForm({ initial, onSave, onCancel }: { initial?: Subject; onSave(name: string, color: string): void; onCancel(): void }) {
  const { t } = useApp();
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? SUBJECT_COLORS[0]!);
  return (
    <form
      className="subject-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name.trim(), color);
      }}
    >
      <input className="input" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t('lib.subjectName')} aria-label={t('lib.subjectName')} onKeyDown={(e) => e.key === 'Escape' && onCancel()} />
      <div className="swatches" role="radiogroup" aria-label={t('lib.subjectColor')}>
        {SUBJECT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === color}
            aria-label={c}
            className={`swatch ${c === color ? 'active' : ''}`}
            style={{ background: c }}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <div className="row gap">
        <button type="submit" className="btn small primary" disabled={!name.trim()}>
          {t('lib.save')}
        </button>
        <button type="button" className="btn small ghost" onClick={onCancel}>
          {t('lib.cancel')}
        </button>
      </div>
    </form>
  );
}

function SubjectList({ current }: { current: 'all' | 'none' | number }) {
  const { t, subjects, navigate, stats, ask, toastError } = useApp();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);

  const create = async (name: string, color: string) => {
    try {
      const s = await post<Subject>('/api/subjects', { name, color });
      setAdding(false);
      navigate(`#/library/${s.id}`);
    } catch (err) {
      toastError(err);
    }
  };
  const update = async (id: number, name: string, color: string) => {
    try {
      await patch(`/api/subjects/${id}`, { name, color });
      setEditing(null);
    } catch (err) {
      toastError(err);
    }
  };
  const remove = async (s: Subject) => {
    const choice = await ask({
      title: t('lib.deleteSubject'),
      message: t('lib.deleteSubjectConfirm', { name: s.name }),
      choices: [
        { id: 'keep', label: t('lib.deleteSubjectKeep') },
        { id: 'all', label: t('lib.deleteSubjectAll'), danger: true },
      ],
    });
    if (choice !== 'keep' && choice !== 'all') return;
    try {
      await del(`/api/subjects/${s.id}?deleteSources=${choice === 'all'}`);
      if (current === s.id) navigate('#/library');
    } catch (err) {
      toastError(err);
    }
  };

  const link = (key: 'all' | 'none' | number, label: string, count: number | null, color?: string) => (
    <a
      href={`#/library/${key}`}
      className={`subject-item ${current === key ? 'active' : ''}`}
      aria-current={current === key ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        navigate(`#/library/${key}`);
      }}
    >
      {color ? <span className="dot-color" style={{ background: color }} /> : <Icon name={key === 'all' ? 'layers' : 'folder'} size={15} />}
      <span className="ellipsis">{label}</span>
      {count !== null && <span className="count">{count}</span>}
    </a>
  );

  return (
    <nav className="subject-col" aria-label={t('lib.subjects')}>
      {link('all', t('lib.allSources'), stats.sources)}
      {link('none', t('lib.noSubject'), null)}
      <div className="group-label row">
        <span>{t('lib.subjects')}</span>
        <button className="icon-btn small" onClick={() => setAdding(true)} aria-label={t('lib.addSubject')} title={t('lib.addSubject')}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      {adding && <SubjectForm onSave={(n, c) => void create(n, c)} onCancel={() => setAdding(false)} />}
      {subjects.map((s) =>
        editing === s.id ? (
          <SubjectForm key={s.id} initial={s} onSave={(n, c) => void update(s.id, n, c)} onCancel={() => setEditing(null)} />
        ) : (
          <div key={s.id} className="subject-row">
            {link(s.id, s.name, s.sourceCount, s.color)}
            <div className="row-actions">
              <button className="icon-btn small" onClick={() => setEditing(s.id)} aria-label={`${t('lib.renameSubject')}: ${s.name}`} title={t('lib.renameSubject')}>
                <Icon name="edit" size={13} />
              </button>
              <button className="icon-btn small danger" onClick={() => void remove(s)} aria-label={`${t('lib.deleteSubject')}: ${s.name}`} title={t('lib.deleteSubject')}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        ),
      )}
      {!subjects.length && !adding && (
        <button className="btn small ghost add-subject" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} /> {t('lib.addSubject')}
        </button>
      )}
    </nav>
  );
}

export function LibraryView({ subject, sourceId }: { subject: 'all' | 'none' | number; sourceId: number | null }) {
  const { t, lang, subjects, importer, setImportTarget, navigate, ask, toastError, openGenerate } = useApp();
  const [sources, setSources] = useState<Source[] | null>(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [preview, setPreview] = useState<{ id: number; chunk: number | null } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const reloadState = useRef<{ timer: number | null; first: number }>({ timer: null, first: 0 });
  const targetSubject = typeof subject === 'number' ? subject : null;
  const subj = typeof subject === 'number' ? subjects.find((s) => s.id === subject) : null;

  useEffect(() => {
    setImportTarget(targetSubject);
    return () => setImportTarget(null);
  }, [targetSubject, setImportTarget]);

  const shownRef = useRef(0);
  const filterKey = `${subject}|${q.trim()}|${status}`;
  const keyRef = useRef(filterKey);
  const params = useCallback(
    (offset: number, limit: number) => {
      const p = new URLSearchParams({ subject: String(subject), offset: String(offset), limit: String(limit) });
      if (q.trim()) p.set('q', q.trim());
      if (status) p.set('status', status);
      return p;
    },
    [subject, q, status],
  );
  /** Generation: jedes Neuladen verwirft noch laufende Antworten (auch Nachladen) – keine Lücken, kein Kürzen. */
  const gen = useRef(0);
  /** Neu laden: bisher geladene Anzahl erhalten (seitenweise à 2 000), bei Filterwechsel zurück auf eine Seite. */
  const load = useCallback(() => {
    const same = keyRef.current === filterKey;
    keyRef.current = filterKey;
    const want = same ? Math.max(PAGE, shownRef.current) : PAGE;
    const my = ++gen.current;
    void (async () => {
      const out: Source[] = [];
      let tot = 0;
      for (let off = 0; off < want; off += 2000) {
        const n = Math.min(2000, want - off);
        const r = await get<{ items: Source[]; total: number }>(`/api/sources?${params(off, n)}`);
        if (gen.current !== my) return;
        const known = new Set(out.map((s) => s.id));
        out.push(...r.items.filter((s) => !known.has(s.id)));
        tot = r.total;
        if (r.items.length < n) break;
      }
      setSources(out);
      setTotal(tot);
    })().catch((e: unknown) => gen.current === my && toastError(e));
  }, [filterKey, params, toastError]);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  // Beim Scrollen nachladen (statt fester Kappung); gerendert werden nur die sichtbaren Zeilen (Fenster, s. u.)
  const sentinel = useRef<HTMLDivElement>(null);
  const loadingMore = useRef(false);
  const loadMore = useCallback(() => {
    const have = shownRef.current;
    if (loadingMore.current || have >= total) return;
    loadingMore.current = true;
    const my = gen.current;
    get<{ items: Source[]; total: number }>(`/api/sources?${params(have, PAGE)}`)
      .then((r) => {
        if (gen.current !== my) return; // inzwischen neu geladen

        setSources((list) => {
          const known = new Set((list ?? []).map((s) => s.id));
          return [...(list ?? []), ...r.items.filter((s) => !known.has(s.id))];
        });
        setTotal(r.total);
      })
      .catch((e: unknown) => toastError(e))
      .finally(() => (loadingMore.current = false));
  }, [total, params, toastError]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, sources]);

  // Fenster: nur sichtbare Zeilen (+ Puffer) rendern – bei 5 200 Quellen ~70 Zeilen im DOM statt 5 200 (Zeilenhöhe gemessen)
  const colRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [rowH, setRowH] = useState(58);
  const [win, setWin] = useState({ start: 0, end: 60 });
  const recompute = useCallback(() => {
    const col = colRef.current;
    const list = listRef.current;
    if (!col || !list) return;
    const first = list.querySelector<HTMLElement>('.source-row');
    const h = first ? first.getBoundingClientRect().height + ROW_GAP : rowH;
    if (Math.abs(h - rowH) > 1) setRowH(h);
    const top = col.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const n = shownRef.current;
    const start = Math.max(0, Math.min(n, Math.floor(top / h) - OVERSCAN));
    const end = Math.min(n, Math.max(start, Math.ceil((top + col.clientHeight) / h)) + OVERSCAN);
    setWin((w) => (w.start === start && w.end === end ? w : { start, end }));
  }, [rowH]);
  useLayoutEffect(() => {
    shownRef.current = sources?.length ?? 0;
    recompute();
  }, [sources, recompute]);
  useEffect(() => {
    const col = colRef.current;
    if (!col) return;
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
    };
    col.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      cancelAnimationFrame(raf);
      col.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
    };
  }, [recompute]);

  /** Entprellt neu laden: erst nach einer Ruhephase, bei Dauer-Ereignissen spätestens alle 5 s. */
  const scheduleReload = useCallback((delay: number) => {
    const st = reloadState.current;
    const now = Date.now();
    if (st.timer === null) st.first = now;
    else clearTimeout(st.timer);
    const wait = Math.max(0, Math.min(delay, st.first + 5000 - now));
    st.timer = window.setTimeout(() => {
      st.timer = null;
      loadRef.current();
    }, wait);
  }, []);

  useEffect(() => {
    const timer = setTimeout(load, q ? 200 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

  useEffect(() => {
    if (sourceId) {
      const chunk = Number(new URLSearchParams(location.hash.split('?')[1] ?? '').get('chunk')) || null;
      setPreview({ id: sourceId, chunk });
    }
  }, [sourceId]);

  useHubEvent((e) => {
    if (e.type === 'source') {
      // bekannte Quelle direkt aktualisieren, neue per entprelltem Reload
      if (sources?.some((s) => s.id === e.source.id)) setSources((list) => list?.map((s) => (s.id === e.source.id ? e.source : s)) ?? list);
      else scheduleReload(800);
    } else if (e.type === 'source-deleted') {
      if (sources?.some((s) => s.id === e.id)) setTotal((n) => Math.max(0, n - 1));
      setSources((list) => list?.filter((s) => s.id !== e.id) ?? list);
      setPreview((p) => (p?.id === e.id ? null : p));
    } else if (e.type === 'queue') {
      scheduleReload(2000); // Vektor-Fortschritt
    }
  });
  useEffect(
    () => () => {
      if (reloadState.current.timer !== null) clearTimeout(reloadState.current.timer);
    },
    [],
  );

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = await collectDropped(e.dataTransfer);
    if (files.length) importer.add(files, targetSubject);
  };

  const move = async (s: Source, subjectId: string) => {
    try {
      await patch(`/api/sources/${s.id}`, { subjectId: subjectId === '' ? null : Number(subjectId) });
      load();
    } catch (err) {
      toastError(err);
    }
  };
  const remove = async (s: Source) => {
    const message = s.childCount ? t('lib.deleteArchiveConfirm', { name: s.name, n: s.childCount }) : t('lib.deleteConfirm', { name: s.name });
    if ((await ask({ title: t('lib.delete'), message, danger: true, confirmLabel: t('common.delete') })) !== true) return;
    try {
      await del(`/api/sources/${s.id}`);
    } catch (err) {
      toastError(err);
    }
  };
  const retry = async (s: Source) => {
    try {
      await post(`/api/sources/${s.id}/retry`);
    } catch (err) {
      toastError(err);
    }
  };

  const title = subject === 'all' ? t('lib.allSources') : subject === 'none' ? t('lib.noSubject') : (subj?.name ?? t('lib.title'));
  const empty = sources !== null && sources.length === 0 && !q && !status;

  return (
    <div className={`view library-view ${preview ? 'with-panel' : ''}`}>
      <ViewHeader icon="library" title={<h1>{t('lib.title')}</h1>}>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          <Icon name="upload" /> {t('lib.importFiles')}
        </button>
        <button className="btn" onClick={() => folderRef.current?.click()}>
          <Icon name="folder" /> {t('lib.importFolder')}
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            importer.add(fromInput(e.target.files), targetSubject);
            e.target.value = '';
          }}
        />
        <input
          ref={folderRef}
          type="file"
          hidden
          // @ts-expect-error – nicht standardisiertes, aber in Chromium/Electron unterstütztes Attribut
          webkitdirectory=""
          multiple
          onChange={(e) => {
            importer.add(fromInput(e.target.files), targetSubject);
            e.target.value = '';
          }}
        />
      </ViewHeader>

      <div className="library">
        <SubjectList current={subject} />
        <section className="source-col" aria-label={title} ref={colRef}>
          <ImportPanel />
          <div
            className={`dropzone ${dragOver ? 'over' : ''} ${empty ? 'big' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => void onDrop(e)}
            onClick={() => fileRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileRef.current?.click()}
            aria-label={t('lib.dropTitle')}
          >
            <div className="drop-icon" aria-hidden="true">
              <Icon name="upload" size={empty ? 34 : 20} />
            </div>
            <div>
              <strong>{empty ? t('lib.emptyTitle') : t('lib.dropTitle')}</strong>
              <p className="muted small">{empty ? t('lib.emptyText') : t('lib.dropText')}</p>
              <p className="small accent-text">{t('lib.dropInto', { subject: subj?.name ?? t('lib.noSubject') })}</p>
            </div>
          </div>

          <div className="toolbar">
            <h2 className="toolbar-title">
              {subj && <span className="dot-color" style={{ background: subj.color }} />}
              {title}
            </h2>
            <span className="muted small" aria-live="polite">
              {sources ? t('lib.count', { n: total }) : ''}
            </span>
            <span className="spacer" />
            <div className="input-icon">
              <Icon name="search" size={15} />
              <input className="input small" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('lib.filter')} aria-label={t('lib.filter')} />
            </div>
            <select className="input small" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="">{t('lib.statusAll')}</option>
              {(['ready', 'queued', 'processing', 'error', 'unsupported', 'cancelled', 'archive'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </select>
          </div>

          {sources === null ? (
            <div className="skeleton-list" aria-hidden="true">
              <div />
              <div />
              <div />
            </div>
          ) : (
            <ul
              className="source-list"
              ref={listRef}
              aria-label={title}
              style={{ paddingTop: win.start * rowH, paddingBottom: Math.max(0, sources.length - win.end) * rowH }}
            >
              {sources.slice(win.start, win.end).map((s, i) => {
                const detail = statusDetailText(s, t);
                return (
                  <li key={s.id} className={`source-row ${preview?.id === s.id ? 'active' : ''}`} aria-posinset={win.start + i + 1} aria-setsize={total}>
                    <KindIcon kind={s.kind} />
                    <button className="source-main" onClick={() => setPreview({ id: s.id, chunk: null })} title={t('lib.preview')}>
                      <span className="source-name ellipsis">{s.name}</span>
                      <span className="source-sub muted small ellipsis">
                        {s.parentId ? `${t('lib.fromArchive')} · ${s.relPath ?? ''}` : (s.relPath ?? '')}
                        {detail ? `${s.relPath || s.parentId ? ' · ' : ''}${detail}` : ''}
                      </span>
                    </button>
                    <StatusBadge source={s} />
                    <span className="source-stat muted small">
                      {s.chunkCount > 0 ? (
                        <>
                          {s.chunkCount === 1 ? t('lib.chunk1') : t('lib.chunks', { n: s.chunkCount })}
                          <span className="mini-bar" aria-label={t('lib.vectors', { done: s.embeddedCount, total: s.chunkCount })}>
                            <span style={{ width: `${Math.round((s.embeddedCount / s.chunkCount) * 100)}%` }} />
                          </span>
                        </>
                      ) : (
                        t('common.none')
                      )}
                    </span>
                    <span className="source-size muted small">{formatBytes(s.size, lang)}</span>
                    <span className="source-date muted small">{formatDate(s.importedAt, lang)}</span>
                    <div className="source-actions">
                      {(s.status === 'error' || s.status === 'cancelled') && (
                        <button className="icon-btn small" onClick={() => void retry(s)} title={t('lib.retry')} aria-label={`${t('lib.retry')}: ${s.name}`}>
                          <Icon name="refresh" size={14} />
                        </button>
                      )}
                      <MoveSelect s={s} subjects={subjects} label={`${t('lib.move')} ${s.name}`} noSubject={t('lib.noSubject')} onMove={(v) => void move(s, v)} />
                      <button className="icon-btn small danger" onClick={() => void remove(s)} title={t('lib.delete')} aria-label={`${t('lib.delete')}: ${s.name}`}>
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {sources !== null && sources.length < total && (
            <div ref={sentinel} className="source-more">
              <button className="btn small ghost" onClick={loadMore}>
                {t('lib.loadMore', { shown: sources.length, total })}
              </button>
            </div>
          )}
          {sources !== null && sources.length === 0 && (q || status) && <p className="muted pad">{t('lib.noMatch')}</p>}
        </section>
      </div>

      {preview && (
        <SourceDrawer
          sourceId={preview.id}
          highlightChunk={preview.chunk}
          onClose={() => {
            setPreview(null);
            if (sourceId) navigate(`#/library/${subject}`);
          }}
          actions={(s) =>
            s.chunkCount > 0 ? (
              <>
              <button
                className="btn small ghost"
                onClick={async () => {
                  const chat = await post<{ id: number }>('/api/chats', { scope: { mode: 'sources', ids: [s.id] } });
                  navigate(`#/chat/${chat.id}`);
                }}
              >
                <Icon name="chat" size={15} /> {t('lib.askChat')}
              </button>
              <button className="btn small ghost" onClick={() => openGenerate({ kind: 'summary', scope: { kind: 'source', id: s.id } })}>
                <Icon name="brain" size={15} /> {t('nav.learn')}
              </button>
              </>
            ) : null
          }
        />
      )}
    </div>
  );
}
