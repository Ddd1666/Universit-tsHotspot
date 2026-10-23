import { useEffect, useRef } from 'react';
import { fileUrl } from '../api';
import { useApp } from '../store';
import { Icon } from './Icon';

/** Sprungziel für den Player; `n` ändert sich bei jedem Klick (auch auf dieselbe Stelle). */
export interface Seek {
  t: number;
  n: number;
}

/**
 * Audio-/Video-Player für eine Quelle. Springt bei jedem neuen `seek` an die Stelle (Datei-Route unterstützt
 * HTTP-Range) und startet die Wiedergabe – ausgelöst durch einen Klick, daher erlaubt der Browser das Abspielen.
 */
export function MediaPlayer({ sourceId, kind, seek }: { sourceId: number; kind: string; seek: Seek | null }) {
  const { t } = useApp();
  const ref = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !seek) return;
    const go = () => {
      el.currentTime = seek.t;
      void el.play().catch(() => {});
    };
    if (el.readyState >= 1) go();
    else el.addEventListener('loadedmetadata', go, { once: true });
    return () => el.removeEventListener('loadedmetadata', go);
  }, [seek]);
  const common = { src: fileUrl(sourceId), controls: true, preload: 'metadata' as const, className: 'media-player', 'aria-label': t('media.player') };
  return kind === 'video' ? <video ref={(el) => void (ref.current = el)} {...common} /> : <audio ref={(el) => void (ref.current = el)} {...common} />;
}

/** Kennzeichnung KI-generierter Inhalte (OCR, Bildbeschreibung, Transkript). */
export function AiBadge({ origin }: { origin: string | null | undefined }) {
  const { t } = useApp();
  if (!origin) return null;
  const key = `ai.origin.${origin}` as 'ai.origin.ocr';
  return (
    <span className="badge ai" title={t('ai.hint')}>
      <Icon name="spark" size={12} /> {t('ai.badge')} · {t(key)}
    </span>
  );
}
