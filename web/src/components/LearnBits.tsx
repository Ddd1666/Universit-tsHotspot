import { fileUrl } from '../api';
import { locLabel } from '../lib/format';
import { useApp } from '../store';
import type { Card, LearnRef, Loc } from '../types';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

export function locText(loc: Loc | null, t: ReturnType<typeof useApp>['t']): string {
  return loc ? locLabel({ locKind: loc.k, locStart: loc.s, locEnd: loc.e, locLabel: loc.l }, t) : '';
}

/** Kennzeichnung KI-generierter Lerninhalte (Notizen, Karten, Fragen, Graph). */
export function AiTag() {
  const { t } = useApp();
  return (
    <span className="badge ai" title={t('learn.aiHint')}>
      <Icon name="spark" size={12} /> {t('ai.badge')}
    </span>
  );
}

/** Quellenverweis: Link zur Stelle in der Bibliothek; gelöschte Quelle mit Hinweis; Chat-Herkunft als Link zum Chat. */
export function RefLink({ r }: { r: Pick<LearnRef, 'sourceId' | 'sourceName' | 'chunkId' | 'loc' | 'deleted' | 'chatId'> & { heading?: string | null } }) {
  const { t, navigate } = useApp();
  const loc = locText(r.loc, t);
  if (r.chatId)
    return (
      <button className="link small" onClick={() => navigate(`#/chat/${r.chatId}`)}>
        <Icon name="chat" size={13} /> {r.sourceName}
      </button>
    );
  if (r.deleted || r.sourceId === null)
    return r.sourceName ? (
      <span className="muted small ref-deleted" title={t('src.deleted')}>
        <Icon name="alert" size={13} /> {t('learn.sourceDeleted', { name: r.sourceName })}
        {loc ? ` · ${loc}` : ''}
      </span>
    ) : null;
  return (
    <button className="link small ref-link" onClick={() => navigate(`#/library/all?source=${r.sourceId}${r.chunkId ? `&chunk=${r.chunkId}` : ''}`)} title={t('src.showInLibrary')}>
      <Icon name="library" size={13} /> <span className="ellipsis">{r.sourceName}</span>
      {loc && <span className="muted"> · {loc}</span>}
      {r.heading && <span className="muted ellipsis"> · {r.heading}</span>}
    </button>
  );
}

export function cardRef(c: Card): Parameters<typeof RefLink>[0]['r'] {
  return c.chat
    ? { sourceId: null, sourceName: c.chat.title, chunkId: null, loc: null, chatId: c.chat.id }
    : { sourceId: c.sourceId, sourceName: c.sourceName ?? '', chunkId: c.chunkId, loc: c.loc, deleted: c.sourceDeleted };
}

/** Lücken: Frage zeigt […], Antwort hebt das Gesuchte hervor (alles Markdown -> DOMPurify). */
export function clozeText(s: string, reveal: boolean): string {
  return s.replace(/\{\{([^{}]{1,200})\}\}/g, (_m, x: string) => (reveal ? `**${x.replace(/[*_]/g, '\\$&')}**` : '[…]'));
}

/** Vorder-/Rückseite einer Karte; Bildkarten zeigen das Bild der Quelle. */
export function CardFace({ card, side }: { card: Pick<Card, 'type' | 'front' | 'back' | 'sourceId' | 'sourceKind'>; side: 'front' | 'back' }) {
  const front = card.type === 'cloze' ? clozeText(card.front, side === 'back') : card.front;
  return (
    <div className="card-face">
      {card.type === 'image' && card.sourceId !== null && card.sourceKind === 'image' && <img className="card-img" src={fileUrl(card.sourceId)} alt="" loading="lazy" />}
      <Markdown text={front} />
      {side === 'back' && card.back && (
        <div className="card-back">
          <Markdown text={card.back} />
        </div>
      )}
    </div>
  );
}
