import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useApp } from '../store';
import { Icon } from './Icon';

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: string;
  run(): void;
}

function score(label: string, q: string): number {
  if (!q) return 1;
  const l = label.toLowerCase();
  const query = q.toLowerCase();
  if (l.startsWith(query)) return 3;
  if (l.includes(query)) return 2;
  // Subsequenz-Treffer ("nch" -> "Neuer Chat")
  let i = 0;
  for (const ch of l) if (ch === query[i]) i++;
  return i === query.length ? 1 : 0;
}

/** Strg+K: Navigation, Aktionen, Chats, Fächer, Suche. */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, t, navigate, chats, subjects, settings, updateSettings, sidebarOpen, setSidebarOpen } = useApp();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen, setPaletteOpen]);

  useEffect(() => {
    if (paletteOpen) {
      prevFocus.current = document.activeElement as HTMLElement | null;
      setQ('');
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else prevFocus.current?.focus?.();
  }, [paletteOpen]);

  const close = () => setPaletteOpen(false);

  const items = useMemo<Item[]>(() => {
    const actions: Item[] = [
      { id: 'new', group: t('cmd.actions'), label: t('chats.new'), icon: 'plus', run: () => navigate('#/chat') },
      { id: 'lib', group: t('cmd.actions'), label: t('nav.library'), icon: 'library', run: () => navigate('#/library') },
      { id: 'search', group: t('cmd.actions'), label: t('nav.search'), icon: 'search', run: () => navigate('#/search') },
      { id: 'settings', group: t('cmd.actions'), label: t('nav.settings'), icon: 'settings', run: () => navigate('#/settings') },
      { id: 'import', group: t('cmd.actions'), label: t('cmd.import'), icon: 'upload', run: () => navigate('#/library?import=1') },
      {
        id: 'theme',
        group: t('cmd.actions'),
        label: t('cmd.toggleTheme'),
        icon: settings.theme === 'dark' ? 'sun' : 'moon',
        run: () => void updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' }),
      },
      { id: 'lang', group: t('cmd.actions'), label: t('cmd.toggleLang'), icon: 'globe', run: () => void updateSettings({ language: settings.language === 'de' ? 'en' : 'de' }) },
      { id: 'sidebar', group: t('cmd.actions'), label: t('cmd.toggleSidebar'), icon: 'sidebar', run: () => setSidebarOpen(!sidebarOpen) },
    ];
    const chatItems: Item[] = chats.slice(0, 50).map((c) => ({ id: `c${c.id}`, group: t('cmd.chats'), label: c.title || t('chats.new'), icon: 'chat', run: () => navigate(`#/chat/${c.id}`) }));
    const subjectItems: Item[] = subjects.map((s) => ({ id: `s${s.id}`, group: t('cmd.subjects'), label: s.name, icon: 'layers', run: () => navigate(`#/library/${s.id}`) }));
    const query = q.trim();
    const ranked = [...actions, ...subjectItems, ...chatItems]
      .map((i) => ({ i, s: score(i.label, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.i)
      .slice(0, query ? 40 : 14);
    if (query) {
      const searchItem: Item = { id: 'q', group: t('nav.search'), label: t('cmd.search', { q: query }), icon: 'search', run: () => navigate(`#/search?q=${encodeURIComponent(query)}`) };
      // Gute Treffer zuerst, sonst direkt "In Unterlagen suchen"
      const strong = ranked.length > 0 && score(ranked[0]!.label, query) >= 2;
      if (strong) ranked.push(searchItem);
      else ranked.unshift(searchItem);
    }
    return ranked;
  }, [q, t, chats, subjects, settings, navigate, updateSettings, sidebarOpen, setSidebarOpen]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!paletteOpen) return null;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[active];
      if (it) {
        close();
        it.run();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') e.preventDefault();
  };

  let lastGroup = '';
  const showHeaders = !q.trim();
  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette glass" role="dialog" aria-modal="true" aria-label="Command Palette" onKeyDown={onKey}>
        <div className="palette-input">
          <Icon name="command" />
          <input
            ref={inputRef}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('cmd.placeholder')}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `pal-${items[active]!.id}` : undefined}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {items.length === 0 && <p className="muted pad">{t('cmd.empty')}</p>}
          {items.map((it, idx) => {
            const header = showHeaders && it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {header && <div className="palette-group">{header}</div>}
                <div
                  id={`pal-${it.id}`}
                  data-idx={idx}
                  role="option"
                  aria-selected={idx === active}
                  className={`palette-item ${idx === active ? 'active' : ''}`}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => {
                    close();
                    it.run();
                  }}
                >
                  <Icon name={it.icon} />
                  <span>{it.label}</span>
                  {!showHeaders && <small className="palette-hint">{it.group}</small>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="palette-foot muted small">{t('cmd.hint')}</div>
      </div>
    </div>
  );
}
