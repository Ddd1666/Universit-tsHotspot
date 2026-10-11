import { useEffect, useRef, useState } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { Dialog } from './components/Dialog';
import { Icon } from './components/Icon';
import { ImportPanel } from './components/ImportPanel';
import { Sidebar } from './components/Sidebar';
import { Toasts } from './components/Toasts';
import { collectDropped } from './lib/importer';
import { useApp } from './store';
import { ChatView } from './views/ChatView';
import { LibraryView } from './views/LibraryView';
import { SearchView } from './views/SearchView';
import { SettingsView } from './views/SettingsView';

export function App() {
  const { route, sidebarOpen, importer, importTarget, subjects, t } = useApp();
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
      if (e.dataTransfer) void collectDropped(e.dataTransfer).then((files) => files.length && importer.add(files, importTarget));
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
  }, [importer, importTarget]);

  const targetName = importTarget ? (subjects.find((s) => s.id === importTarget)?.name ?? '') : t('lib.noSubject');

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <div className="bg-fx" aria-hidden="true" />
      <a href="#main" className="skip-link" onClick={(e) => (e.preventDefault(), document.getElementById('main')?.focus())}>
        Skip to content
      </a>
      <Sidebar />
      <main id="main" className="main" tabIndex={-1}>
        {route.view === 'chat' && <ChatView chatId={route.chatId} />}
        {route.view === 'library' && <LibraryView subject={route.subject} sourceId={route.sourceId} />}
        {route.view === 'search' && <SearchView initialQuery={route.q} />}
        {route.view === 'settings' && <SettingsView />}
      </main>
      <ImportPanel />
      <CommandPalette />
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
