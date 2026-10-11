import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { fileUrl, get, patch, post, type ApiError } from '../api';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { ViewHeader } from '../components/ViewHeader';
import { formatTime, locLabel, prefersReducedMotion } from '../lib/format';
import { reloadUntilFinal } from '../lib/chat-sync';
import { streams } from '../lib/streams';
import { useApp } from '../store';
import { errorText } from '../lib/errors';
import type { ChatMessage, ChatSession, Citation, Scope, Source } from '../types';

const EMBED_RE = /embed|bge-|minilm|e5-|gte-|nomic-bert/i;

/* ------------------------------------------------------------------ Wissensbereich */

function ScopePicker({ scope, onChange }: { scope: Scope; onChange(s: Scope): void }) {
  const { t, subjects } = useApp();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sources, setSources] = useState<Source[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || scope.mode !== 'sources') return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      get<{ items: Source[] }>(`/api/sources?q=${encodeURIComponent(q)}`, ctrl.signal)
        .then((r) => setSources(r.items.filter((s) => s.status === 'ready' || s.status === 'archive')))
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [open, scope.mode, q]);

  const label =
    scope.mode === 'all'
      ? t('scope.all')
      : scope.mode === 'none'
        ? t('scope.none')
        : scope.mode === 'subjects'
          ? t('scope.subjectsN', { n: scope.ids.length })
          : t('scope.sourcesN', { n: scope.ids.length });

  const toggle = (id: number) => {
    if (scope.mode !== 'subjects' && scope.mode !== 'sources') return;
    const ids = scope.ids.includes(id) ? scope.ids.filter((x) => x !== id) : [...scope.ids, id];
    onChange({ mode: scope.mode, ids });
  };

  return (
    <div className="popover-wrap" ref={ref}>
      <button className={`chip ${scope.mode === 'none' ? 'warn' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" title={t('scope.label')}>
        <Icon name="layers" size={15} />
        {label}
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="popover glass" role="dialog" aria-label={t('scope.label')}>
          <div className="popover-title">{t('scope.label')}</div>
          {(['all', 'subjects', 'sources', 'none'] as const).map((m) => (
            <label key={m} className="radio-row">
              <input
                type="radio"
                name="scope-mode"
                checked={scope.mode === m}
                onChange={() => onChange(m === 'subjects' || m === 'sources' ? { mode: m, ids: [] } : { mode: m })}
              />
              <span>{t(`scope.${m}` as 'scope.all')}</span>
            </label>
          ))}
          {scope.mode === 'subjects' && (
            <div className="scope-list">
              {subjects.length === 0 && <p className="muted small">{t('scope.noSubjects')}</p>}
              {subjects.map((s) => (
                <label key={s.id} className="check-row">
                  <input type="checkbox" checked={scope.ids.includes(s.id)} onChange={() => toggle(s.id)} />
                  <span className="dot-color" style={{ background: s.color }} />
                  <span className="ellipsis">{s.name}</span>
                  <span className="muted small">{s.sourceCount}</span>
                </label>
              ))}
            </div>
          )}
          {scope.mode === 'sources' && (
            <div className="scope-list">
              <input className="input small" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('scope.searchSources')} />
              {sources.map((s) => (
                <label key={s.id} className="check-row">
                  <input type="checkbox" checked={scope.ids.includes(s.id)} onChange={() => toggle(s.id)} />
                  <span className="ellipsis" title={s.relPath ?? s.name}>
                    {s.name}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModelPicker({ value, onChange }: { value: string | null; onChange(m: string | null): void }) {
  const { t, ollama, settings } = useApp();
  const models = ollama.models.filter((m) => !EMBED_RE.test(m.name) && !EMBED_RE.test(m.family ?? ''));
  const installed = (name: string) => models.some((m) => m.name === name || m.name === `${name}:latest`);
  return (
    <label className="select-chip" title={t('chat.model')}>
      <Icon name="cpu" size={15} />
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label={t('chat.model')}>
        <option value="">{t('chat.modelDefault', { model: settings.chatModel })}</option>
        {models.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name}
            {m.parameterSize ? ` · ${m.parameterSize}` : ''}
          </option>
        ))}
        {value && !installed(value) && <option value={value}>{`${value} (${t('set.notInstalled')})`}</option>}
      </select>
    </label>
  );
}

/* ------------------------------------------------------------------ Nachrichten */

function CitationChips({ msg, onOpen }: { msg: ChatMessage; onOpen(n: number): void }) {
  const { t } = useApp();
  if (!msg.citations.length) return null;
  const used = msg.citations.filter((c) => c.used);
  const shown = msg.status === 'streaming' ? msg.citations : used.length ? used : msg.citations;
  return (
    <div className="cite-row">
      <span className="muted small">{t('chat.sources')}:</span>
      {shown.map((c) => (
        <button key={c.n} className={`cite-chip ${c.used ? 'used' : ''}`} onClick={() => onOpen(c.n)} title={`${c.sourceName} ${locLabel(c, t)}`}>
          <span className="cite-n">{c.n}</span>
          <span className="ellipsis">{c.sourceName}</span>
          {locLabel(c, t) && <span className="muted">· {locLabel(c, t)}</span>}
        </button>
      ))}
      {used.length > 0 && used.length < msg.citations.length && msg.status !== 'streaming' && (
        <button className="link small" onClick={() => onOpen(used[0]!.n)}>
          +{msg.citations.length - used.length} {t('chat.sourcesChecked')}
        </button>
      )}
    </div>
  );
}

function MessageItem({ msg, isLast, onCite, onRegenerate, canRegenerate }: { msg: ChatMessage; isLast: boolean; onCite(n: number): void; onRegenerate(): void; canRegenerate: boolean }) {
  const { t, lang } = useApp();
  const [copied, setCopied] = useState(false);
  if (msg.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">{msg.content}</div>
      </div>
    );
  }
  const streaming = msg.status === 'streaming';
  const copy = () => {
    void navigator.clipboard?.writeText(msg.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const r = msg.retrieval;
  return (
    <div className={`msg assistant ${streaming ? 'is-streaming' : ''}`}>
      <div className="avatar" aria-hidden="true">
        <Icon name="spark" size={16} />
      </div>
      <div className="msg-body">
        {msg.thinking && (
          <details className="thinking" open={streaming && !msg.content}>
            <summary>
              <Icon name="brain" size={14} /> {streaming && !msg.content ? t('chat.thinkingLive') : t('chat.thinking')}
            </summary>
            <div className="thinking-text">{msg.thinking}</div>
          </details>
        )}
        {msg.content ? (
          <Markdown text={msg.content} maxCite={msg.citations.length} onCite={onCite} streaming={streaming} />
        ) : streaming && !msg.thinking ? (
          <div className="typing" aria-label={t('common.loading')}>
            <span />
            <span />
            <span />
          </div>
        ) : null}
        {msg.status === 'error' && msg.error && (
          <div className="msg-error" role="alert">
            <Icon name="alert" size={16} />
            <span>{errorText(t, msg.error, msg.model ?? undefined)}</span>
          </div>
        )}
        {msg.status === 'aborted' && <div className="muted small">— {t('chat.aborted')}</div>}
        <CitationChips msg={msg} onOpen={onCite} />
        {!streaming && (
          <div className="msg-foot">
            <button className="icon-btn small" onClick={copy} title={t('chat.copy')} aria-label={t('chat.copy')}>
              <Icon name={copied ? 'check' : 'copy'} size={14} />
            </button>
            {isLast && canRegenerate && (
              <button className="icon-btn small" onClick={onRegenerate} title={t('chat.regenerate')} aria-label={t('chat.regenerate')}>
                <Icon name="refresh" size={14} />
              </button>
            )}
            <span className="muted small mono">
              {msg.model ?? ''} · {formatTime(msg.createdAt, lang)}
            </span>
            {r && r.mode !== 'error' && (
              <span className="muted small mono">
                · {t('chat.retrieval', { mode: t(`search.mode.${r.mode}` as 'search.mode.hybrid'), hits: r.hits, ms: r.tookMs })}
              </span>
            )}
            {r?.vectorError && <span className="warn small">· {t('chat.vectorOff')}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function SourcesPanel({ citations, active, onClose }: { citations: Citation[]; active: number; onClose(): void }) {
  const { t, navigate } = useApp();
  useEffect(() => {
    document.getElementById(`cite-card-${active}`)?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [active]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className="drawer sources-panel glass" aria-label={t('chat.sources')}>
      <header className="drawer-head">
        <Icon name="layers" />
        <h2>{t('chat.sources')}</h2>
        <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
          <Icon name="close" />
        </button>
      </header>
      <div className="drawer-body">
        {citations.length === 0 && <p className="muted">{t('chat.noSources')}</p>}
        {citations.map((c) => (
          <article key={c.n} id={`cite-card-${c.n}`} className={`cite-card ${c.n === active ? 'active' : ''} ${c.used ? 'used' : ''}`}>
            <header>
              <span className="cite-n big">{c.n}</span>
              <div className="cite-title">
                <strong className="ellipsis" title={c.sourceName}>
                  {c.sourceName}
                </strong>
                <span className="muted small">
                  {c.subjectName && (
                    <>
                      <span className="dot-color" style={{ background: c.subjectColor ?? 'var(--accent)' }} /> {c.subjectName} ·{' '}
                    </>
                  )}
                  {locLabel(c, t)}
                  {c.used ? ` · ${t('chat.sourcesUsed')}` : ` · ${t('chat.sourcesChecked')}`}
                </span>
              </div>
            </header>
            {c.heading && <div className="muted small ellipsis">{c.heading}</div>}
            <p className="cite-snippet">{c.snippet}</p>
            <div className="cite-actions">
              <a className="btn small" href={fileUrl(c.sourceId)} target="_blank" rel="noopener noreferrer">
                <Icon name="external" size={14} /> {t('src.open')}
              </a>
              <a className="btn small ghost" href={fileUrl(c.sourceId, true)} download>
                <Icon name="download" size={14} /> {t('src.download')}
              </a>
              <button className="btn small ghost" onClick={() => navigate(`#/library/all?source=${c.sourceId}&chunk=${c.chunkId}`)}>
                <Icon name="library" size={14} /> {t('src.showInLibrary')}
              </button>
            </div>
          </article>
        ))}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ Hauptansicht */

export function ChatView({ chatId }: { chatId: number | null }) {
  const { t, navigate, toast, toastError, ollama, stats, settings } = useApp();
  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [draftScope, setDraftScope] = useState<Scope>({ mode: 'all' });
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ messageId: number; n: number } | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const currentChat = useRef<number | null>(chatId);
  currentChat.current = chatId;

  useSyncExternalStore(streams.subscribe, streams.getVersion);
  const live = streams.get(chatId);

  const load = useCallback(
    async (id: number) => {
      try {
        // Nach Stream-Ende (auch Stopp) warten, bis der Server die Antwort final gespeichert hat;
        // bis dahin bleibt die lokale Live-Anzeige (inkl. Teiltext) stehen.
        const live0 = streams.get(id);
        const { data: r, final } = await reloadUntilFinal(
          () => get<{ session: ChatSession; messages: ChatMessage[] }>(`/api/chats/${id}`),
          live0?.done ? live0.assistant.id : -1,
        );
        if (currentChat.current !== id) return;
        setSession(r.session);
        setMessages(r.messages);
        if (final) streams.clear(id);
      } catch (err) {
        if (currentChat.current !== id) return;
        if ((err as ApiError).status === 404) {
          toast(t('chats.notFound'), 'error');
          navigate('#/chat');
        } else toastError(err);
      }
    },
    [navigate, toast, toastError, t],
  );

  useEffect(() => {
    setPanel(null);
    setEditingTitle(false);
    stickToBottom.current = true;
    if (chatId === null) {
      setSession(null);
      setMessages([]);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    void load(chatId);
  }, [chatId, load]);

  const display = useMemo(() => {
    if (!live) return messages;
    const hide = new Set([live.userMessage?.id, live.assistant.id].filter((x): x is number => typeof x === 'number' && x > 0));
    const base = messages.filter((m) => !hide.has(m.id));
    return [...base, ...(live.userMessage ? [live.userMessage] : []), live.assistant];
  }, [messages, live]);

  const isStreaming = !!live && !live.done;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [display]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const startStream = (id: number, body: { content?: string; regenerate?: boolean }) => {
    stickToBottom.current = true;
    streams.start(
      id,
      body,
      () => {
        if (currentChat.current === id) void load(id);
      },
      (s) => currentChat.current === id && setSession(s),
    );
  };

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || isStreaming) return;
    setInput('');
    let id = chatId;
    if (id === null) {
      try {
        const s = await post<ChatSession>('/api/chats', { scope: draftScope, model: draftModel });
        id = s.id;
        currentChat.current = id;
        setSession(s);
        navigate(`#/chat/${id}`);
      } catch (err) {
        toastError(err);
        setInput(content);
        return;
      }
    }
    startStream(id, { content });
  };

  const regenerate = () => {
    if (!chatId || isStreaming) return;
    setMessages((ms) => {
      const lastUser = [...ms].reverse().find((m) => m.role === 'user');
      return lastUser ? ms.filter((m) => m.id <= lastUser.id) : ms;
    });
    startStream(chatId, { regenerate: true });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  // Textarea automatisch wachsen lassen
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input]);

  const scope = session?.scope ?? draftScope;
  const model = session ? session.model : draftModel;
  const updateSession = async (p: { scope?: Scope; model?: string | null; title?: string }) => {
    if (!session) {
      if (p.scope) setDraftScope(p.scope);
      if (p.model !== undefined) setDraftModel(p.model);
      return;
    }
    try {
      setSession(await patch<ChatSession>(`/api/chats/${session.id}`, p));
    } catch (err) {
      toastError(err);
    }
  };

  const saveTitle = () => {
    setEditingTitle(false);
    if (session && titleDraft.trim() && titleDraft.trim() !== session.title) void updateSession({ title: titleDraft.trim() });
  };

  const panelMsg = panel ? display.find((m) => m.id === panel.messageId) : null;
  const lastAssistant = [...display].reverse().find((m) => m.role === 'assistant');
  const empty = display.length === 0;

  return (
    <div className={`view chat-view ${panelMsg ? 'with-panel' : ''}`}>
      <ViewHeader
        icon="chat"
        title={
          editingTitle && session ? (
            <input
              className="title-input"
              value={titleDraft}
              autoFocus
              maxLength={120}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              aria-label={t('chat.titleEdit')}
            />
          ) : (
            <button
              className="title-btn"
              disabled={!session}
              onClick={() => {
                setTitleDraft(session?.title ?? '');
                setEditingTitle(true);
              }}
              title={session ? t('chat.titleEdit') : undefined}
            >
              <h1>{session?.title || t('chats.new')}</h1>
              {session && <Icon name="edit" size={14} className="title-edit-icon" />}
            </button>
          )
        }
      >
        <ScopePicker scope={scope} onChange={(s) => void updateSession({ scope: s })} />
        <ModelPicker value={model} onChange={(m) => void updateSession({ model: m })} />
      </ViewHeader>

      <div className="chat-body">
        <div className="messages" ref={scrollRef} onScroll={onScroll} aria-live="polite" aria-busy={isStreaming}>
          {empty ? (
            <div className="welcome">
              <div className="welcome-orb" aria-hidden="true" />
              <h2>{t('chat.welcomeTitle')}</h2>
              <p className="muted">{t('chat.welcomeText')}</p>
              {stats.sources === 0 && scope.mode !== 'none' && (
                <button className="notice" onClick={() => navigate('#/library')}>
                  <Icon name="info" size={16} /> {t('chat.noLibrary')}
                </button>
              )}
              <div className="suggestions">
                {(['chat.suggest1', 'chat.suggest2', 'chat.suggest3'] as const).map((k) => (
                  <button key={k} className="suggestion" onClick={() => void send(t(k))}>
                    <Icon name="spark" size={14} /> {t(k)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="message-list">
              {display.map((m) => (
                <MessageItem
                  key={`${m.role}-${m.id}`}
                  msg={m}
                  isLast={m === lastAssistant}
                  canRegenerate={!isStreaming}
                  onRegenerate={regenerate}
                  onCite={(n) => setPanel({ messageId: m.id, n })}
                />
              ))}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          {!ollama.reachable && (
            <button className="notice warn" onClick={() => navigate('#/settings')}>
              <Icon name="alert" size={16} /> {t('err.unreachable')}
            </button>
          )}
          <div className="composer glass">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              rows={1}
              maxLength={20000}
              placeholder={scope.mode === 'none' ? t('chat.placeholderFree') : t('chat.placeholder')}
              aria-label={t('chat.placeholder')}
            />
            {isStreaming ? (
              <button className="btn danger send-btn" onClick={() => chatId && streams.stop(chatId)} aria-label={t('chat.stop')}>
                <Icon name="stop" /> <span className="hide-sm">{t('chat.stop')}</span>
              </button>
            ) : (
              <button className="btn primary send-btn" onClick={() => void send()} disabled={!input.trim()} aria-label={t('chat.send')}>
                <Icon name="send" /> <span className="hide-sm">{t('chat.send')}</span>
              </button>
            )}
          </div>
          <div className="composer-meta muted small mono">
            {(session?.model ?? draftModel ?? settings.chatModel) + ` · num_ctx ${settings.numCtx}`}
          </div>
        </div>
      </div>

      {panelMsg && <SourcesPanel citations={panelMsg.citations} active={panel!.n} onClose={() => setPanel(null)} />}
    </div>
  );
}
