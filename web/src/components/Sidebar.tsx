import { useEffect, useMemo, useState } from 'react';
import { del, get, patch } from '../api';
import { dayBucket, formatTime } from '../lib/format';
import { useApp } from '../store';
import type { ChatSession } from '../types';
import { Icon } from './Icon';
import { ImportMini } from './ImportPanel';

function OllamaPill() {
  const { ollama, queue, t, navigate } = useApp();
  const busy = queue.ingest.processing.length > 0 || queue.ingest.queued > 0 || queue.embed.state === 'running';
  const running = ollama.running[0];
  const label = ollama.mock ? t('ollama.mock') : ollama.reachable ? t('ollama.online') : t('ollama.offline');
  return (
    <button className={`status-pill ${ollama.reachable ? 'ok' : 'off'}`} onClick={() => navigate('#/settings')} title={ollama.error ?? ollama.url}>
      <span className="dot" aria-hidden="true" />
      <span className="status-text">
        <strong>{label}</strong>
        <small>{running ? `${running.name} · ${t('set.gpu', { p: running.gpuPercent })}` : ollama.version ? `v${ollama.version}` : ollama.url}</small>
      </span>
      {busy && <span className="spinner" aria-label="busy" />}
    </button>
  );
}

export function Sidebar() {
  const { t, lang, route, navigate, chats, sidebarOpen, setSidebarOpen, ask, toastError, setPaletteOpen, boot } = useApp();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ChatSession[] | null>(null);

  useEffect(() => {
    if (!q.trim()) {
      setResults(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      get<ChatSession[]>(`/api/chats?q=${encodeURIComponent(q.trim())}`, ctrl.signal)
        .then(setResults)
        .catch(() => {});
    }, 220);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && window.innerWidth <= 900 && !document.querySelector('.overlay')) setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarOpen, setSidebarOpen]);

  const list = results ?? chats;
  const groups = useMemo(() => {
    const order = ['today', 'yesterday', 'week', 'older'] as const;
    const g = new Map<string, ChatSession[]>();
    for (const c of list) {
      const b = dayBucket(c.updatedAt);
      g.set(b, [...(g.get(b) ?? []), c]);
    }
    return order.filter((k) => g.has(k)).map((k) => ({ key: k, items: g.get(k)! }));
  }, [list]);

  const activeChat = route.view === 'chat' ? route.chatId : null;
  const isMobile = () => window.innerWidth <= 900;
  const go = (hash: string) => {
    navigate(hash);
    if (isMobile()) setSidebarOpen(false);
  };

  const rename = async (c: ChatSession) => {
    const v = await ask({ title: t('chats.rename'), input: { value: c.title, label: t('chats.renamePrompt') }, confirmLabel: t('lib.save') });
    if (typeof v !== 'string') return;
    try {
      await patch(`/api/chats/${c.id}`, { title: v });
    } catch (err) {
      toastError(err);
    }
  };
  const remove = async (c: ChatSession) => {
    const ok = await ask({ title: t('chats.delete'), message: t('chats.deleteConfirm', { title: c.title || t('chats.new') }), danger: true, confirmLabel: t('common.delete') });
    if (ok !== true) return;
    try {
      await del(`/api/chats/${c.id}`);
      if (activeChat === c.id) navigate('#/chat');
    } catch (err) {
      toastError(err);
    }
  };

  const nav = [
    { view: 'chat', hash: '#/chat', icon: 'chat', label: t('nav.chat') },
    { view: 'library', hash: '#/library', icon: 'library', label: t('nav.library') },
    { view: 'search', hash: '#/search', icon: 'search', label: t('nav.search') },
    { view: 'settings', hash: '#/settings', icon: 'settings', label: t('nav.settings') },
  ];

  return (
    <>
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
      <aside className={`sidebar ${sidebarOpen ? 'open' : 'closed'}`} aria-label="Navigation" inert={!sidebarOpen}>
        <div className="brand">
          <div className="logo" aria-hidden="true">
            <svg viewBox="0 0 64 64" width="30" height="30">
              <path d="M32 6 54 19v26L32 58 10 45V19Z" fill="none" stroke="url(#lg)" strokeWidth="4" strokeLinejoin="round" />
              <circle cx="32" cy="32" r="7" fill="url(#lg)" />
              <defs>
                <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="var(--accent)" />
                  <stop offset="1" stopColor="var(--accent-2)" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <div className="brand-text">
            <strong>
              {t('app.name')} {boot.mock && <span className="mock-tag">MOCK</span>}
            </strong>
            <small>{t('app.tagline')}</small>
          </div>
          <button className="icon-btn" onClick={() => setSidebarOpen(false)} aria-label={t('nav.collapse')} title={t('nav.collapse')}>
            <Icon name="sidebar" />
          </button>
        </div>

        <nav className="nav">
          {nav.map((n) => (
            <a
              key={n.view}
              href={n.hash}
              className={`nav-item ${route.view === n.view ? 'active' : ''}`}
              aria-current={route.view === n.view ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                go(n.hash);
              }}
            >
              <Icon name={n.icon} />
              <span>{n.label}</span>
            </a>
          ))}
        </nav>

        <button className="btn primary new-chat" onClick={() => go('#/chat')}>
          <Icon name="plus" />
          {t('chats.new')}
        </button>

        <div className="chat-search">
          <Icon name="search" size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('chats.search')} aria-label={t('chats.search')} />
          {q && (
            <button className="icon-btn small" onClick={() => setQ('')} aria-label={t('common.close')}>
              <Icon name="close" size={13} />
            </button>
          )}
        </div>

        <div className="chat-list">
          {list.length === 0 && <p className="muted small pad">{results ? t('chats.noMatch') : t('chats.empty')}</p>}
          {groups.map((g) => (
            <div key={g.key} className="chat-group">
              <div className="group-label">{t(`chats.${g.key}` as 'chats.today')}</div>
              <ul>
                {g.items.map((c) => (
                  <li key={c.id} className={`chat-item ${activeChat === c.id ? 'active' : ''}`}>
                    <a
                      href={`#/chat/${c.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        go(`#/chat/${c.id}`);
                      }}
                      aria-current={activeChat === c.id ? 'page' : undefined}
                    >
                      <span className="chat-title">{c.title || t('chats.new')}</span>
                      <span className="chat-meta">
                        {c.match ? <em>{c.match}</em> : formatTime(c.updatedAt, lang)}
                      </span>
                    </a>
                    <div className="chat-actions">
                      <button className="icon-btn small" onClick={() => void rename(c)} aria-label={`${t('chats.rename')}: ${c.title || t('chats.new')}`} title={t('chats.rename')}>
                        <Icon name="edit" size={14} />
                      </button>
                      <button className="icon-btn small danger" onClick={() => void remove(c)} aria-label={`${t('chats.delete')}: ${c.title || t('chats.new')}`} title={t('chats.delete')}>
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <ImportMini />
        <footer className="sidebar-footer">
          <OllamaPill />
          <button className="kbd-hint" onClick={() => setPaletteOpen(true)}>
            <Icon name="command" size={14} />
            <kbd>{lang === 'de' ? 'Strg' : 'Ctrl'}</kbd>
            <kbd>K</kbd>
          </button>
        </footer>
      </aside>
    </>
  );
}
