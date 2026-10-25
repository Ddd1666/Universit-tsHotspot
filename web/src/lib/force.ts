/**
 * Kleine Force-Simulation für den Wissensgraphen (keine Abhängigkeit). Abstoßung paarweise (O(n²)), Federn entlang
 * der Kanten, leichte Schwerkraft zur Mitte, Abkühlung (alpha) wie bei d3-force. Gemessen (README „Messwerte“):
 * 2 000 Knoten ≈ wenige ms pro Schritt – reicht für eine flüssige Ansicht; Simulation stoppt nach dem Abkühlen.
 * ponytail: O(n²)-Abstoßung; ab ~5 000 Knoten Barnes-Hut (Quadtree) oder d3-force nachrüsten.
 */
export interface SimNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** fixiert (gezogen) */
  fx: number | null;
  fy: number | null;
}

export interface Sim {
  alpha: number;
  tick(): void;
  /** wieder „aufheizen“ (z. B. beim Ziehen eines Knotens) */
  reheat(a?: number): void;
  readonly done: boolean;
}

const ALPHA_MIN = 0.002;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300); // ~300 Schritte bis zum Stillstand
const VELOCITY_DECAY = 0.6;
const CHARGE = -60;
const LINK_DIST = 50;
const GRAVITY = 0.02;

/** Startpositionen auf einer Spirale (deterministisch, keine Überlagerung). */
export function initPositions<T extends Partial<SimNode>>(nodes: T[]): (T & SimNode)[] {
  return nodes.map((n, i) => {
    const r = 10 * Math.sqrt(i + 0.5);
    const a = i * Math.PI * (3 - Math.sqrt(5));
    return Object.assign(n, { x: n.x ?? r * Math.cos(a), y: n.y ?? r * Math.sin(a), vx: 0, vy: 0, fx: null, fy: null });
  });
}

export function createSim(nodes: SimNode[], links: [number, number][]): Sim {
  const n = nodes.length;
  const deg = new Float64Array(n);
  for (const [s, t] of links) {
    deg[s]!++;
    deg[t]!++;
  }
  const sim: Sim = {
    alpha: 1,
    get done() {
      return sim.alpha < ALPHA_MIN;
    },
    reheat(a = 0.3) {
      sim.alpha = Math.max(sim.alpha, a);
    },
    tick() {
      const alpha = sim.alpha;
      // Federn
      for (const [s, t] of links) {
        const a = nodes[s]!;
        const b = nodes[t]!;
        let dx = b.x + b.vx - a.x - a.vx || 1e-6;
        let dy = b.y + b.vy - a.y - a.vy || 1e-6;
        const l = Math.sqrt(dx * dx + dy * dy);
        const k = ((l - LINK_DIST) / l) * alpha * (1 / Math.min(deg[s]!, deg[t]!));
        dx *= k;
        dy *= k;
        const bias = deg[s]! / (deg[s]! + deg[t]!);
        b.vx -= dx * bias;
        b.vy -= dy * bias;
        a.vx += dx * (1 - bias);
        a.vy += dy * (1 - bias);
      }
      // Abstoßung (paarweise)
      for (let i = 0; i < n; i++) {
        const a = nodes[i]!;
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j]!;
          const dx = b.x - a.x || 1e-3;
          const dy = b.y - a.y || 1e-3;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) d2 = 1;
          const f = (CHARGE * alpha) / d2;
          a.vx += dx * f;
          a.vy += dy * f;
          b.vx -= dx * f;
          b.vy -= dy * f;
        }
      }
      for (const p of nodes) {
        p.vx -= p.x * GRAVITY * alpha;
        p.vy -= p.y * GRAVITY * alpha;
        if (p.fx !== null && p.fy !== null) {
          p.x = p.fx;
          p.y = p.fy;
          p.vx = p.vy = 0;
        } else {
          p.vx *= VELOCITY_DECAY;
          p.vy *= VELOCITY_DECAY;
          p.x += p.vx;
          p.y += p.vy;
        }
      }
      sim.alpha += (0 - sim.alpha) * ALPHA_DECAY;
    },
  };
  return sim;
}
