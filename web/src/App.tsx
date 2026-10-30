import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { Dialog } from './components/Dialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Icon } from './components/Icon';
import { Sidebar } from './components/Sidebar';
import { Toasts } from './components/Toasts';
import { collectDropped } from './lib/importer';
import { useApp } from './store';
import { ChatView } from './views/ChatView';
import { LibraryView } from './views/LibraryView';

// Seltener genutzte Ansichten erst bei Bedarf laden (kleineres Startpaket -> schnellerer Start)
const SearchView = lazy(() => import('./views/SearchView').then((m) => ({ default: m.SearchView })));
const SettingsView = lazy(() => import('./views/SettingsView').then((m) => ({ default: m.SettingsView })));
const QueueView = lazy(() => import('./views/QueueView').then((m) => ({ default: m.QueueView })));
const LearnView = lazy(() => import('./views/LearnView').then((m) => ({ default: m.LearnView })));
const GenerateDialog = lazy(() => import('./views/LearnView').then((m) => ({ default: m.GenerateDialog })));
const BackupView = lazy(() => import('./views/BackupView').then((m) => ({ default: m.BackupView })));
const DiagnosticsView = lazy(() => import('./views/DiagnosticsView').then((m) => ({ default: m.DiagnosticsView })));
const Wizard = lazy(() => import('./components/Wizard').then((m) => ({ default: m.Wizard })));

function ViewFallback() {
  return (
    <div className="view">
      <div className="skeleton-list pad" aria-hidden="true">
        <div />
        <div />
        <div />
      </div>
    </div>
  );
}

export function App() {
  const { route, sidebarOpen, importer, importTarget, subjects, t, toast, gen, wizardOpen } = useApp();
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  // Globales Drag & Drop: Dateien überall ablegen -> Import (ins aktuell gewählte Fach)
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current++;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    // Capture-Phase: Overlay immer zurücksetzen, auch wenn eine Dropzone das Ereignis selbst behandelt
    const onDropCapture = () => {
      dragDepth.current = 0;
      setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!e.dataTransfer) return;
      void collectDropped(e.dataTransfer).then((files) => {
        if (!files.length) return;
        importer.add(files, importTarget);
        toast(t('import.started', { n: files.length }), 'info');
      });
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDropCapture, true);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDropCapture, true);
      window.removeEventListener('drop', onDrop);
    };
  }, [importer, importTarget, toast, t]);

  const targetName = importTarget ? (subjects.find((s) => s.id === importTarget)?.name ?? '') : t('lib.noSubject');

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <div className="bg-fx" aria-hidden="true" />
      <a href="#main" className="skip-link" onClick={(e) => (e.preventDefault(), document.getElementById('main')?.focus())}>
        {t('a11y.skip')}
      </a>
      <Sidebar />
      <main id="main" className="main" tabIndex={-1}>
        <ErrorBoundary key={route.view} t={t}>
          <Suspense fallback={<ViewFallback />}>
            {route.view === 'chat' && <ChatView chatId={route.chatId} />}
            {route.view === 'library' && <LibraryView subject={route.subject} sourceId={route.sourceId} />}
            {route.view === 'search' && <SearchView initialQuery={route.q} />}
            {route.view === 'settings' && <SettingsView />}
            {route.view === 'queue' && <QueueView />}
            {route.view === 'backup' && <BackupView />}
            {route.view === 'diagnostics' && <DiagnosticsView />}
            {route.view === 'learn' && <LearnView tab={route.tab} subject={route.subject} source={route.source} note={route.note} />}
          </Suspense>
        </ErrorBoundary>
      </main>
      <CommandPalette />
      <Suspense fallback={null}>
        {gen && <GenerateDialog req={gen} />}
        {wizardOpen && <Wizard />}
      </Suspense>
      <Dialog />
      <Toasts />
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-card glass">
            <Icon name="upload" size={42} />
            <strong>{t('lib.dropHere')}</strong>
            <span className="muted">{t('lib.dropInto', { subject: targetName })}</span>
          </div>
        </div>
      )}
    </div>
  );
}
