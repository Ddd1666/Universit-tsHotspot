import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { connectEvents, get, onConnection, onHubEvent, put } from './api';
import { translate, type Lang, type T, type TKey } from './i18n';
import { apiErrorText } from './lib/errors';
import { ImportManager } from './lib/importer';
import type { Bootstrap, ChatSession, HubEvent, OllamaStatus, QueueStatus, Settings, Stats, Subject } from './types';

export type Route =
  | { view: 'chat'; chatId: number | null }
  | { view: 'library'; subject: 'all' | 'none' | number; sourceId: number | null }
  | { view: 'search'; q: string }
  | { view: 'settings' };

export function parseRoute(hash: string): Route {
  const [pathPart, query = ''] = hash.replace(/^#/, '').split('?');
  const parts = (pathPart ?? '').split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  switch (parts[0]) {
    case 'library': {
      const s = parts[1];
      const sourceId = Number(params.get('source')) || null;
      return { view: 'library', subject: s === 'none' ? 'none' : s && /^\d+$/.test(s) ? Number(s) : 'all', sourceId };
    }
    case 'search':
      return { view: 'search', q: params.get('q') ?? '' };
    case 'settings':
      return { view: 'settings' };
    default:
      return { view: 'chat', chatId: parts[1] && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null };
  }
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface DialogRequest {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  input?: { value: string; label: string };
  choices?: { id: string; label: string; danger?: boolean }[];
  resolve: (v: string | boolean | null) => void;
}

interface AppState {
  boot: Bootstrap;
  settings: Settings;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  subjects: Subject[];
  reloadSubjects(): void;
  ollama: OllamaStatus;
  setOllama(s: OllamaStatus): void;
  queue: QueueStatus;
  stats: Stats;
  chats: ChatSession[];
  reloadChats(): void;
  t: T;
  lang: Lang;
  route: Route;
  navigate(hash: string): void;
  toasts: Toast[];
  toast(text: string, kind?: Toast['kind']): void;
  /** Fehler lokalisiert anzeigen (API-Fehlercodes werden übersetzt) */
  toastError(err: unknown): void;
  dismissToast(id: number): void;
  dialog: DialogRequest | null;
  ask(req: Omit<DialogRequest, 'resolve'>): Promise<string | boolean | null>;
  closeDialog(v: string | boolean | null): void;
  sidebarOpen: boolean;
  setSidebarOpen(v: boolean): void;
  paletteOpen: boolean;
  setPaletteOpen(v: boolean): void;
  importer: ImportManager;
  importTarget: number | null;
  setImportTarget(id: number | null): void;
  connected: boolean;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppProvider fehlt');
  return v;
}

/** Abonniert Server-Events (SSE) für die Lebensdauer der Komponente. */
export function useHubEvent(fn: (e: HubEvent) => void): void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => onHubEvent((e) => ref.current(e)), []);
}

function applyAppearance(s: Settings): void {
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.dataset.accent = s.accent;
  root.dataset.motion = s.motion;
  root.lang = s.language;
  try {
    localStorage.setItem('hotspot-appearance', JSON.stringify({ theme: s.theme, accent: s.accent, motion: s.motion, language: s.language }));
  } catch {
    /* ignore */
  }
}

export function AppProvider({ boot, children }: { boot: Bootstrap; children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(boot.settings);
  const [subjects, setSubjects] = useState<Subject[]>(boot.subjects);
  const [ollama, setOllama] = useState<OllamaStatus>(boot.ollama);
  const [queue, setQueue] = useState<QueueStatus>(boot.queue);
  const [stats, setStats] = useState<Stats>(boot.stats);
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [sidebarOpen, setSidebarOpenState] = useState<boolean>(() => {
    try {
      return localStorage.getItem('hotspot-sidebar') !== '0' && window.innerWidth > 900;
    } catch {
      return window.innerWidth > 900;
    }
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [importTarget, setImportTarget] = useState<number | null>(null);
  const [connected, setConnected] = useState(true);
  const importer = useMemo(() => new ImportManager(), []);
  const toastId = useRef(1);

  const lang = settings.language;
  const t = useCallback<T>((key: TKey, vars) => translate(lang, key, vars), [lang]);

  useEffect(() => applyAppearance(settings), [settings]);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = toastId.current++;
    setToasts((ts) => [...ts.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 3500);
  }, []);
  const toastError = useCallback((err: unknown) => toast(apiErrorText(t, err), 'error'), [toast, t]);
  const dismissToast = useCallback((id: number) => setToasts((ts) => ts.filter((x) => x.id !== id)), []);

  const reloadSubjects = useCallback(() => {
    void get<Subject[]>('/api/subjects').then(setSubjects).catch(() => {});
    void get<Stats>('/api/stats').then(setStats).catch(() => {});
  }, []);
  const reloadChats = useCallback(() => {
    void get<ChatSession[]>('/api/chats').then(setChats).catch(() => {});
  }, []);

  const updateSettings = useCallback(
    async (p: Partial<Settings>) => {
      try {
        const r = await put<{ settings: Settings; queue: QueueStatus }>('/api/settings', p);
        setSettings(r.settings);
        setQueue(r.queue);
      } catch (err) {
        toast(apiErrorText(t, err), 'error');
        throw err;
      }
    },
    [toast, t],
  );

  const navigate = useCallback((hash: string) => {
    if (location.hash !== hash) location.hash = hash;
    else setRoute(parseRoute(hash));
  }, []);

  const ask = useCallback((req: Omit<DialogRequest, 'resolve'>) => new Promise<string | boolean | null>((resolve) => setDialog({ ...req, resolve })), []);
  const closeDialog = useCallback(
    (v: string | boolean | null) => {
      setDialog((d) => {
        d?.resolve(v);
        return null;
      });
    },
    [],
  );

  const setSidebarOpen = useCallback((v: boolean) => {
    setSidebarOpenState(v);
    try {
      localStorage.setItem('hotspot-sidebar', v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    // Wechsel auf schmales Fenster: Seitenleiste als Overlay schließen (nicht speichern)
    const mq = window.matchMedia('(max-width: 900px)');
    const onMq = () => mq.matches && setSidebarOpenState(false);
    mq.addEventListener('change', onMq);
    return () => mq.removeEventListener('change', onMq);
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onHash);
    connectEvents();
    reloadChats();
    const offConn = onConnection(setConnected);
    return () => {
      window.removeEventListener('hashchange', onHash);
      offConn();
    };
  }, [reloadChats]);

  useHubEvent((e) => {
    switch (e.type) {
      case 'subjects':
        reloadSubjects();
        break;
      case 'queue':
        setQueue({ ingest: e.ingest, embed: e.embed });
        break;
      case 'ollama':
        setOllama(e.status);
        break;
      case 'settings':
        setSettings(e.settings);
        break;
      case 'chat':
        if (e.session) {
          const s = e.session;
          setChats((cs) => [s, ...cs.filter((c) => c.id !== s.id)].sort((a, b) => b.updatedAt - a.updatedAt));
        }
        break;
      case 'chat-deleted':
        setChats((cs) => cs.filter((c) => c.id !== e.id));
        break;
      case 'source':
        importer.onSource(e.source);
        break;
      case 'source-deleted':
        break;
    }
  });

  const value: AppState = {
    boot,
    settings,
    updateSettings,
    subjects,
    reloadSubjects,
    ollama,
    setOllama,
    queue,
    stats,
    chats,
    reloadChats,
    t,
    lang,
    route,
    navigate,
    toasts,
    toast,
    toastError,
    dismissToast,
    dialog,
    ask,
    closeDialog,
    sidebarOpen,
    setSidebarOpen,
    paletteOpen,
    setPaletteOpen,
    importer,
    importTarget,
    setImportTarget,
    connected,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Fehlermeldung eines Ollama-/API-Fehlers lokalisiert aufbereiten. */
export function errorText(t: T, err: { code?: string; message: string }, model?: string): string {
  switch (err.code) {
    case 'unreachable':
    case 'ollama_unreachable':
      return t('err.unreachable');
    case 'model_missing':
      return t('err.model_missing', { model: model ?? '<modell>' });
    case 'oom':
      return t('err.oom');
    case 'timeout':
      return t('err.timeout');
    default:
      return t('err.generic', { message: err.message });
  }
}
