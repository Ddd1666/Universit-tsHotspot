import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { del, get, patch, post } from '../api';
import { Icon } from '../components/Icon';
import { ImportPanel } from '../components/ImportPanel';
import { KindIcon, SourceDrawer, StatusBadge, statusDetailText } from '../components/SourceBits';
import { ViewHeader } from '../components/ViewHeader';
import { formatBytes, formatDate, SUBJECT_COLORS } from '../lib/format';
import { collectDropped, fromInput } from '../lib/importer';
import { useApp, useHubEvent } from '../store';
import type { Source, Subject } from '../types';

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
  const { t, lang, subjects, importer, setImportTarget, navigate, ask, toastError } = useApp();
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

  const load = useCallback(() => {
    const params = new URLSearchParams({ subject: String(subject) });
    if (q.trim()) params.set('q', q.trim());
    if (status) params.set('status', status);
    get<{ items: Source[]; total: number }>(`/api/sources?${params}`)
      .then((r) => {
        setSources(r.items);
        setTotal(r.total);
      })
      .catch((e: unknown) => toastError(e));
  }, [subject, q, status, toastError]);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

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
        <section className="source-col" aria-label={title}>
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
            <span className={`muted small ${sources && total > sources.length ? 'warn' : ''}`}>
              {sources ? (total > sources.length ? t('lib.countOf', { shown: sources.length, total }) : t('lib.count', { n: sources.length })) : ''}
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
            <ul className="source-list">
              {sources.map((s) => {
                const detail = statusDetailText(s, t);
                return (
                  <li key={s.id} className={`source-row ${preview?.id === s.id ? 'active' : ''}`}>
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
                      <select className="move-select" value={s.subjectId ?? ''} onChange={(e) => void move(s, e.target.value)} aria-label={`${t('lib.move')} ${s.name}`} title={t('lib.move')}>
                        <option value="">{t('lib.noSubject')}</option>
                        {subjects.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                      <button className="icon-btn small danger" onClick={() => void remove(s)} title={t('lib.delete')} aria-label={`${t('lib.delete')}: ${s.name}`}>
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
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
              <button
                className="btn small ghost"
                onClick={async () => {
                  const chat = await post<{ id: number }>('/api/chats', { scope: { mode: 'sources', ids: [s.id] } });
                  navigate(`#/chat/${chat.id}`);
                }}
              >
                <Icon name="chat" size={15} /> {t('lib.askChat')}
              </button>
            ) : null
          }
        />
      )}
    </div>
  );
}
