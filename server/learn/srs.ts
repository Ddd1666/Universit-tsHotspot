/**
 * Wiederholungs-Algorithmus: SM-2 (SuperMemo, P. Woźniak 1987), exakt nach der verbreiteten Referenz-Formulierung
 * (Wikipedia „SuperMemo“, Abschnitt „Description of SM-2 algorithm“):
 *   q ≥ 3:  n=0 → I=1, n=1 → I=6, sonst I=round(I·EF); n+1      q < 3:  n=0, I=1
 *   EF' = EF + (0.1 − (5−q)·(0.08 + (5−q)·0.02)), mindestens 1.3
 * Tasten 1–4 → q: 1 Nochmal = 1, 2 Schwer = 3, 3 Gut = 4, 4 Leicht = 5.
 * Zusatz aus der Originalbeschreibung (Schritt 7): nicht gewusste Karten kommen am selben Tag erneut (in 10 min).
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
}

export const NEW_CARD: SrsState = { reps: 0, ease: 2.5, intervalDays: 0 };
const QUALITY: Record<Rating, number> = { 1: 1, 2: 3, 3: 4, 4: 5 };
const DAY = 86_400_000;
export const RELEARN_MS = 10 * 60_000;

export function review(s: SrsState, rating: Rating, now: number): SrsState & { due: number; lapse: boolean } {
  const q = QUALITY[rating];
  let { reps, intervalDays } = s;
  if (q >= 3) {
    intervalDays = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(intervalDays * s.ease);
    reps++;
  } else {
    reps = 0;
    intervalDays = 1;
  }
  const ease = Math.max(1.3, s.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  const lapse = q < 3;
  return { reps, ease: Math.round(ease * 1000) / 1000, intervalDays, due: lapse ? now + RELEARN_MS : now + intervalDays * DAY, lapse };
}
