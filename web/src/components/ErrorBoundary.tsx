import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { T } from '../i18n';
import { Icon } from './Icon';

/** Fehlerseite statt weißer Fläche: ein Renderfehler in einer Ansicht legt nicht die ganze App lahm. */
export class ErrorBoundary extends Component<{ t: T; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // nur Konsole (lokal); Inhalte verlassen den Rechner nie
    console.warn('Ansicht abgestürzt:', error.message, info.componentStack?.split('\n').slice(0, 4).join('\n'));
  }

  render() {
    const { error } = this.state;
    const { t } = this.props;
    if (!error) return this.props.children;
    const details = `${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(1, 6).join('\n')}`;
    return (
      <div className="view">
        <div className="error-page glass" role="alert">
          <Icon name="alert" size={34} />
          <h1>{t('crash.title')}</h1>
          <p className="muted">{t('crash.text')}</p>
          <pre className="mono small">{details}</pre>
          <div className="row gap wrap">
            <button className="btn primary" onClick={() => location.reload()}>
              <Icon name="refresh" size={15} /> {t('crash.reload')}
            </button>
            <button className="btn ghost" onClick={() => this.setState({ error: null })}>
              {t('crash.retry')}
            </button>
            <button className="btn ghost" onClick={() => void navigator.clipboard?.writeText(details)}>
              <Icon name="copy" size={15} /> {t('crash.copy')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
