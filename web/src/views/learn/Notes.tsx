import { useCallback, useEffect, useRef, useState } from 'react';
import { del, get, patch, post } from '../../api';
import { Icon } from '../../components/Icon';
import { AiTag, RefLink } from '../../components/LearnBits';
import { Markdown } from '../../components/Markdown';
import { formatDate } from '../../lib/format';
import { useApp, useHubEvent } from '../../store';
import type { Note, NoteSummary } from '../../types';

/** Notizen: Liste + Ansicht (Markdown über DOMPurify, Zitate [n] springen zur Quellenliste), bearbeiten, Export. */
export function NotesTab({ subject, noteId, onOpen }: { subject: number | null; noteId: number | null; onOpen(id: number | null): void }) {
  const { t, lang, ask, toastError } = useApp();
  const [list, setList] = useState<NoteSummary[] | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [edit, setEdit] = useState<{ title: string; body: string } | null>(null);
  const openRef = useRef(onOpen);
  useEffect(() => {
    openRef.current = onOpen;
  });

  const loadList = useCallback(() => {
    get<NoteSummary[]>(`/api/notes${subject ? `?subject=${subject}` : ''}`)
      .then(setList)
      .catch(toastError);
  }, [subject, toastError]);
  useEffect(loadList, [loadList]);
  useHubEvent((e) => {
    if (e.type === 'learn-job' && e.job.kind === 'summary' && e.job.state === 'done') loadList();
  });
  useEffect(() => {
    setEdit(null);
    if (!noteId) return setNote(null);
    get<Note>(`/api/notes/${noteId}`)
      .then(setNote)
      .catch((err) => {
        toastError(err);
        openRef.current(null);
      });
  }, [noteId, toastError]);

  const create = async () => {
    try {
      const n = await post<Note>('/api/notes', { title: t('notes.new'), body: '', subjectId: subject });
      loadList();
      onOpen(n.id);
      setEdit({ title: n.title, body: '' });
    } catch (err) {
      toastError(err);
    }
  };
  const save = async () => {
    if (!note || !edit) return;
    try {
      setNote(await patch<Note>(`/api/notes/${note.id}`, { title: edit.title, body: edit.body }));
      setEdit(null);
      loadList();
    } catch (err) {
      toastError(err);
    }
  };
  const remove = async () => {
    if (!note) return;
    if ((await ask({ title: t('notes.delete'), message: t('notes.deleteConfirm', { title: note.title }), danger: true, confirmLabel: t('common.delete') })) !== true) return;
    try {
      await del(`/api/notes/${note.id}`);
      onOpen(null);
      loadList();
    } catch (err) {
      toastError(err);
    }
  };
  const exportMd = async () => {
    if (!note) return;
    try {
      const r = await get<{ name: string; markdown: string }>(`/api/notes/${note.id}/export`);
      const url = URL.createObjectURL(new Blob([r.markdown], { type: 'text/markdown;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = r.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div className={`notes-tab ${note ? 'has-note' : ''}`}>
      <nav className="notes-list" aria-label={t('learn.tab.notes')}>
        <button className="btn small" onClick={() => void create()}>
          <Icon name="plus" size={14} /> {t('notes.new')}
        </button>
        {list?.length === 0 && <p className="muted small">{t('notes.empty')}</p>}
        <ul>
          {list?.map((n) => (
            <li key={n.id}>
              <button className={`note-item ${n.id === noteId ? 'active' : ''}`} onClick={() => onOpen(n.id)} aria-current={n.id === noteId ? 'true' : undefined}>
                <span className="ellipsis">{n.title}</span>
                <span className="muted small">
                  {n.level ? t(`level.${n.level}`) : ''} {n.ai ? `· ${t('ai.badge')}` : ''} · {formatDate(n.updatedAt, lang)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <section className="note-view glass">
        {!note ? (
          <p className="muted pad">{t('notes.pick')}</p>
        ) : edit ? (
          <form
            className="note-edit"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="field">
              <span>{t('notes.titleLabel')}</span>
              <input value={edit.title} maxLength={200} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            </label>
            <label className="field grow">
              <span>{t('notes.body')}</span>
              <textarea className="input" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
            </label>
            <div className="row gap">
              <button type="submit" className="btn small primary" disabled={!edit.title.trim()}>
                {t('notes.save')}
              </button>
              <button type="button" className="btn small ghost" onClick={() => setEdit(null)}>
                {t('lib.cancel')}
              </button>
            </div>
          </form>
        ) : (
          <>
            <header className="note-head">
              <button className="icon-btn small note-back" onClick={() => onOpen(null)} aria-label={t('notes.back')}>
                <Icon name="chevron" size={14} />
              </button>
              <h2>{note.title}</h2>
              <div className="row gap wrap">
                {note.ai && <AiTag />}
                {note.level && <span className="badge muted">{t(`level.${note.level}`)}</span>}
                {note.edited && <span className="muted small">{t('notes.edited')}</span>}
                <span className="spacer" />
                <button className="btn small ghost" onClick={() => setEdit({ title: note.title, body: note.body })}>
                  <Icon name="edit" size={14} /> {t('notes.edit')}
                </button>
                <button className="btn small ghost" onClick={() => void exportMd()}>
                  <Icon name="download" size={14} /> {t('notes.export')}
                </button>
                <button className="icon-btn small danger" onClick={() => void remove()} aria-label={t('notes.delete')} title={t('notes.delete')}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </header>
            {note.ai && <p className="muted small">{t('learn.aiHint')}</p>}
            {note.scope.truncated && (
              <p className="warn small">
                <Icon name="alert" size={13} /> {t('notes.truncated')}
              </p>
            )}
            <div className="note-body">
              <Markdown text={note.body} maxCite={note.citations.length} onCite={(n) => document.getElementById(`note-ref-${n}`)?.scrollIntoView({ block: 'center' })} />
            </div>
            {note.citations.length > 0 && (
              <section aria-labelledby="note-refs">
                <h3 id="note-refs">{t('notes.sources')}</h3>
                <ol className="note-refs">
                  {note.citations.map((c) => (
                    <li key={c.n} id={`note-ref-${c.n}`}>
                      <span className="cite-n">{c.n}</span> <RefLink r={c} />
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
      </section>
    </div>
  );
}
