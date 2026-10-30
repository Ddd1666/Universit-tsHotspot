import { useState } from 'react';
import { useApp } from '../store';
import { Icon } from './Icon';

/** Befehl/Pfad zum Kopieren (z. B. `ollama pull …` – die App führt so etwas nie selbst aus). */
export function CopyCmd({ cmd }: { cmd: string }) {
  const { t } = useApp();
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-cmd">
      <code>{cmd}</code>
      <button
        className="btn small"
        aria-label={`${t('set.copy')}: ${cmd}`}
        onClick={() =>
          void navigator.clipboard?.writeText(cmd).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? t('set.copied') : t('set.copy')}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? t('set.copied') : ''}
      </span>
    </div>
  );
}
