import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { get } from './api';
import { App } from './App';
import { AppProvider } from './store';
import type { Bootstrap } from './types';
import './styles.css';

// Erscheinungsbild sofort setzen (kein Aufblitzen beim Start)
try {
  const saved = JSON.parse(localStorage.getItem('hotspot-appearance') ?? '{}') as Record<string, string>;
  const root = document.documentElement;
  if (saved.theme) root.dataset.theme = saved.theme;
  if (saved.accent) root.dataset.accent = saved.accent;
  if (saved.motion) root.dataset.motion = saved.motion;
} catch {
  /* ignore */
}

const rootEl = document.getElementById('root')!;
const root = createRoot(rootEl);

function BootError({ message }: { message: string }) {
  return (
    <div className="boot-screen">
      <div className="boot-card glass">
        <h1>Uni-Hotspot</h1>
        <p>Der lokale Server ist nicht erreichbar / The local server is not reachable.</p>
        <pre>{message}</pre>
        <button className="btn primary" onClick={() => location.reload()}>
          Neu laden / Reload
        </button>
      </div>
    </div>
  );
}

async function start(attempt = 0): Promise<void> {
  try {
    const boot = await get<Bootstrap>('/api/bootstrap');
    root.render(
      <StrictMode>
        <AppProvider boot={boot}>
          <App />
        </AppProvider>
      </StrictMode>,
    );
  } catch (err) {
    if (attempt < 3) {
      setTimeout(() => void start(attempt + 1), 800 * (attempt + 1));
      return;
    }
    root.render(<BootError message={(err as Error).message} />);
  }
}

root.render(
  <div className="boot-screen">
    <div className="boot-logo" aria-label="Uni-Hotspot lädt" />
  </div>,
);
void start();
