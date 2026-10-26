/**
 * Wiederholungs-Algorithmus: SM-2 (SuperMemo, P. Woźniak 1987), exakt nach der verbreiteten Referenz-Formulierung
 * (Wikipedia „SuperMemo“, Abschnitt „Description of SM-2 algorithm“):
 *   q ≥ 3:  n=0 → I=1, n=1 → I=6, sonst I=round(I·EF); n+1      q < 3:  n=0, I=1
 *   EF' = EF + (0.1 − (5−q)·(0.08 + (5−q)·0.02)), mindestens 1.3
 * Tasten 1–4 → q: 1 Nochmal = 1, 2 Schwer = 3, 3 Gut = 4, 4 Leicht = 5.
 * Schritt 7 der Originalbeschreibung: nicht gewusste Karten werden am Ende derselben Sitzung wiederholt, bis sie sitzen –
 * diese Wiederholungen am selben Tag ändern EF NICHT erneut (die Karte gilt als "neu gelernt", nächster Termin morgen).
 *
 * Warum SM-2 statt FSRS: Referenzwerte sind von Hand nachrechenbar (Tests), keine Parameter, die erst mit eigener
 * Review-Historie optimiert werden müssten. Der vollständige Verlauf (Bewertung + Zeitpunkt) wird gespeichert –
 * ponytail: FSRS mit optimierten Gewichten lässt sich später daraus nachrüsten, ohne Daten zu verlieren.
 */
export type Rating = 1 | 2 | 3 | 4;

export interface SrsState {
  reps: number;
  ease: number;
  intervalDays: number;
  /** letzte Bewertung (für "heute schon einmal nicht gewusst") */
  lastReview?: number | null;
}

export const NEW_CARD: SrsState = { reps: 0, ease: 2.5, intervalDays: 0, lastReview: null };
const QUALITY: Record<Rating, number> = { 1: 1, 2: 3, 3: 4, 4: 5 };
const DAY = 86_400_000;

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

export function review(s: SrsState, rating: Rating, now: number): SrsState & { due: number; lapse: boolean } {
  const q = QUALITY[rating];
  // heute bereits nicht gewusst (n=0, letzte Bewertung heute): Wiederholung nach Schritt 7, EF bleibt
  const relearn = s.reps === 0 && s.lastReview != null && sameDay(s.lastReview, now);
  let { reps, intervalDays } = s;
  if (q >= 3) {
    intervalDays = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(intervalDays * s.ease);
    reps++;
  } else {
    reps = 0;
    intervalDays = 1;
  }
  const ease = relearn ? s.ease : Math.max(1.3, s.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  const lapse = q < 3;
  // nicht gewusst: sofort wieder fällig (kommt am Ende der laufenden Sitzung erneut), sonst nach I Tagen
  return { reps, ease: Math.round(ease * 1000) / 1000, intervalDays, lastReview: now, due: lapse ? now : now + intervalDays * DAY, lapse: lapse && !relearn };
}
