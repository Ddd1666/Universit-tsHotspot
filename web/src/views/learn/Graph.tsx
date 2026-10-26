import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, patch, post } from '../../api';
import { Icon } from '../../components/Icon';
import { AiTag, RefLink } from '../../components/LearnBits';
import { createSim, initPositions, type SimNode } from '../../lib/force';
import { prefersReducedMotion } from '../../lib/format';
import { useApp, useHubEvent } from '../../store';
import type { ConceptDetail, GraphEdge, GraphNode, Source } from '../../types';

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  total: number;
  truncated: boolean;
}

type VNode = GraphNode & SimNode;

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

/**
 * Canvas-Ansicht: eigene Force-Simulation (lib/force.ts), Zoom (Mausrad/Knöpfe), Verschieben (Hintergrund ziehen),
 * Knoten ziehen, Klick = Details. Beschriftungen nur per fillText (Text, nie HTML). Reduzierte Bewegung: Layout wird
 * ohne Animation berechnet und einmal gezeichnet.
 */
function GraphCanvas({ data, selected, onSelect }: { data: GraphData; selected: number | null; onSelect(id: number | null): void }) {
  const { t, settings } = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef({ x: 0, y: 0, k: 1 });
  const redraw = useRef<() => void>(() => {});
  const fitRef = useRef<() => void>(() => {});
  const interacted = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  // Positionen über Neuladen hinweg behalten (Umbenennen/Ausblenden soll das Layout nicht neu würfeln)
  const positions = useRef(new Map<number, { x: number; y: number }>());

  const graph = useMemo(() => {
    const known = data.nodes.filter((n) => positions.current.has(n.id)).length;
    const nodes = initPositions(data.nodes.map((n) => ({ ...n, ...positions.current.get(n.id) }))) as VNode[];
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    const links = data.edges.map((e) => [index.get(e.a)!, index.get(e.b)!] as [number, number]).filter(([a, b]) => a !== undefined && b !== undefined);
    const neighbors = new Map<number, Set<number>>();
    for (const e of data.edges) {
      neighbors.set(e.a, (neighbors.get(e.a) ?? new Set()).add(e.b));
      neighbors.set(e.b, (neighbors.get(e.b) ?? new Set()).add(e.a));
    }
    const sim = createSim(nodes, links);
    if (nodes.length && known / nodes.length > 0.9) sim.alpha = 0.05;
    // Beschriftungs-Rangfolge: am stärksten vernetzte zuerst
    const rank = new Map([...nodes].sort((x, y) => y.degree - x.degree).map((n, i) => [n.id, i]));
    return { nodes, links, neighbors, sim, rank };
  }, [data]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const { nodes, links, neighbors, sim, rank } = graph;
    let raf = 0;
    let stopped = false;
    const colors = { accent: css('--accent'), accent2: css('--accent-2'), text: css('--text'), dim: css('--text-faint'), line: css('--border-strong') };
    const radius = (n: VNode) => 3 + Math.min(9, Math.sqrt(n.degree) * 1.6);

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const v = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.translate(w / 2 + v.x, h / 2 + v.y);
      ctx.scale(v.k, v.k);
      const sel = selectedRef.current;
      const near = sel !== null ? (neighbors.get(sel) ?? new Set<number>()) : null;
      ctx.lineWidth = 1 / v.k;
      ctx.strokeStyle = colors.line;
      ctx.globalAlpha = near ? 0.25 : 0.7;
      ctx.beginPath();
      for (const [a, b] of links) {
        ctx.moveTo(nodes[a]!.x, nodes[a]!.y);
        ctx.lineTo(nodes[b]!.x, nodes[b]!.y);
      }
      ctx.stroke();
      if (sel !== null) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 2 / v.k;
        ctx.beginPath();
        for (const [a, b] of links) {
          if (nodes[a]!.id !== sel && nodes[b]!.id !== sel) continue;
          ctx.moveTo(nodes[a]!.x, nodes[a]!.y);
          ctx.lineTo(nodes[b]!.x, nodes[b]!.y);
        }
        ctx.stroke();
      }
      for (const n of nodes) {
        const hl = n.id === sel || near?.has(n.id);
        ctx.globalAlpha = near && !hl ? 0.35 : n.hidden ? 0.4 : 1;
        ctx.fillStyle = n.id === sel ? colors.accent2 : colors.accent;
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius(n), 0, Math.PI * 2);
        ctx.fill();
      }
      // Beschriftung: wichtige Knoten, beim Hineinzoomen mehr; Auswahl + Nachbarn immer
      ctx.globalAlpha = 1;
      ctx.font = `${12 / v.k}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      // so viele Beschriftungen, wie bei dieser Zoomstufe lesbar sind (Rest beim Hineinzoomen)
      const budget = Math.max(25, Math.round(60 * v.k * v.k * Math.max(1, canvas.clientWidth / 900)));
      for (const n of nodes) {
        const hl = n.id === sel || near?.has(n.id);
        if (!hl && rank.get(n.id)! >= budget) continue;
        ctx.fillStyle = hl ? colors.text : colors.dim;
        ctx.fillText(n.name, n.x + radius(n) + 3 / v.k, n.y);
      }
    };
    redraw.current = draw;
    // Ansicht folgt dem Layout (alles sichtbar), bis der Nutzer selbst zoomt/verschiebt
    interacted.current = false;
    const fit = () => {
      if (!nodes.length) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of nodes) {
        x0 = Math.min(x0, n.x);
        y0 = Math.min(y0, n.y);
        x1 = Math.max(x1, n.x);
        y1 = Math.max(y1, n.y);
      }
      const k = Math.min(3, Math.max(0.05, 0.9 * Math.min(canvas.clientWidth / (x1 - x0 + 80), canvas.clientHeight / (y1 - y0 + 80))));
      view.current = { k, x: (-(x0 + x1) / 2) * k, y: (-(y0 + y1) / 2) * k };
    };
    fitRef.current = () => {
      interacted.current = false;
      fit();
      draw();
    };

    const remember = () => {
      for (const n of nodes) positions.current.set(n.id, { x: n.x, y: n.y });
    };
    const loop = () => {
      if (stopped) return;
      sim.tick();
      if (!interacted.current) fit();
      draw();
      if (!sim.done) raf = requestAnimationFrame(loop);
      else remember();
    };
    const reduced = settings.motion === 'reduced' || prefersReducedMotion();
    if (reduced) {
      // ohne Animation: Layout in Häppchen berechnen (Oberfläche bleibt bedienbar), dann einmal zeichnen
      const step = () => {
        if (stopped) return;
        // Zeitscheiben < ~12 ms: auch 2 000 Knoten erzeugen keine langen Tasks (Oberfläche bleibt bedienbar)
        const t0 = performance.now();
        while (!sim.done && performance.now() - t0 < 12) sim.tick();
        if (sim.done) {
          fit();
          draw();
          remember();
        } else setTimeout(step, 0);
      };
      step();
    } else raf = requestAnimationFrame(loop);

    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);

    // Zeiger: Knoten ziehen, Hintergrund verschieben, Klick = Auswahl
    const toWorld = (cx: number, cy: number) => {
      const r = canvas.getBoundingClientRect();
      const v = view.current;
      return { x: (cx - r.left - r.width / 2 - v.x) / v.k, y: (cy - r.top - r.height / 2 - v.y) / v.k };
    };
    const hit = (cx: number, cy: number): VNode | null => {
      const p = toWorld(cx, cy);
      let best: VNode | null = null;
      let bd = Infinity;
      for (const n of nodes) {
        const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2;
        const r = radius(n) + 5 / view.current.k;
        if (d < r * r && d < bd) {
          best = n;
          bd = d;
        }
      }
      return best;
    };
    let drag: { node: VNode | null; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null;
    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      drag = { node: hit(e.clientX, e.clientY), sx: e.clientX, sy: e.clientY, vx: view.current.x, vy: view.current.y, moved: false };
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
      if (!drag.moved) return;
      interacted.current = true;
      if (drag.node) {
        const p = toWorld(e.clientX, e.clientY);
        drag.node.fx = p.x;
        drag.node.fy = p.y;
        if (sim.done && !reduced) {
          sim.reheat(0.15);
          raf = requestAnimationFrame(loop);
        } else if (reduced) {
          drag.node.x = p.x;
          drag.node.y = p.y;
          draw();
        }
      } else {
        interacted.current = true;
        view.current.x = drag.vx + e.clientX - drag.sx;
        view.current.y = drag.vy + e.clientY - drag.sy;
        draw();
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!drag) return;
      if (drag.node) {
        drag.node.fx = null;
        drag.node.fy = null;
      }
      if (!drag.moved) onSelectRef.current(hit(e.clientX, e.clientY)?.id ?? null);
      drag = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      interacted.current = true;
      const v = view.current;
      const r = canvas.getBoundingClientRect();
      const k = Math.min(8, Math.max(0.1, v.k * Math.exp(-e.deltaY * 0.0015)));
      // um den Mauszeiger zoomen
      const mx = e.clientX - r.left - r.width / 2;
      const my = e.clientY - r.top - r.height / 2;
      v.x = mx - ((mx - v.x) * k) / v.k;
      v.y = my - ((my - v.y) * k) / v.k;
      v.k = k;
      draw();
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      stopped = true;
      remember();
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [graph, settings.motion, settings.theme, settings.accent]);

  useEffect(() => redraw.current(), [selected]);

  const zoom = (f: number) => {
    interacted.current = true;
    view.current.k = Math.min(8, Math.max(0.1, view.current.k * f));
    redraw.current();
  };
  return (
    <div className="graph-canvas-wrap">
      <canvas ref={canvasRef} className="graph-canvas" role="img" aria-label={t('graph.canvasLabel')} />
      <div className="graph-zoom">
        <button className="icon-btn small" onClick={() => zoom(1.25)} aria-label={t('graph.zoomIn')} title={t('graph.zoomIn')}>
          <Icon name="plus" size={15} />
        </button>
        <button className="icon-btn small" onClick={() => zoom(0.8)} aria-label={t('graph.zoomOut')} title={t('graph.zoomOut')}>
          <Icon name="minus" size={15} />
        </button>
        <button
          className="icon-btn small"
          onClick={() => {
            fitRef.current();
          }}
          aria-label={t('graph.reset')}
          title={t('graph.reset')}
        >
          <Icon name="refresh" size={15} />
        </button>
      </div>
      <p className="graph-hint muted small">{t('graph.hint')}</p>
    </div>
  );
}

function ConceptPanel({ id, onClose, onChanged }: { id: number; onClose(): void; onChanged(): void }) {
  const { t, ask, navigate, toastError } = useApp();
  const [c, setC] = useState<ConceptDetail | null>(null);
  const load = useCallback(() => {
    get<ConceptDetail>(`/api/graph/concepts/${id}`)
      .then(setC)
      .catch((err) => {
        toastError(err);
        onClose();
      });
  }, [id, toastError, onClose]);
  useEffect(load, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.overlay') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const update = async (body: Record<string, unknown>) => {
    try {
      setC(await patch<ConceptDetail>(`/api/graph/concepts/${id}`, body));
      onChanged();
    } catch (err) {
      toastError(err);
    }
  };
  const rename = async () => {
    const v = await ask({ title: t('graph.rename'), input: { value: c?.name ?? '', label: t('graph.concept') }, confirmLabel: t('lib.save') });
    if (typeof v === 'string') await update({ name: v });
  };
  const edge = async (edgeId: number, body: Record<string, unknown>) => {
    try {
      await patch(`/api/graph/edges/${edgeId}`, body);
      load();
      onChanged();
    } catch (err) {
      toastError(err);
    }
  };
  const relabel = async (edgeId: number, label: string) => {
    const v = await ask({ title: t('graph.editLabel'), input: { value: label, label: t('graph.links') }, confirmLabel: t('lib.save') });
    if (typeof v === 'string') await edge(edgeId, { label: v });
  };
  const askChat = async () => {
    if (!c) return;
    try {
      const ids = [...new Set(c.sources.map((s) => s.sourceId))];
      const chat = await post<{ id: number }>('/api/chats', { title: `${t('graph.concept')}: ${c.name}`.slice(0, 120), scope: { mode: 'sources', ids } });
      navigate(`#/chat/${chat.id}?ask=${encodeURIComponent(t('graph.askText', { name: c.name }))}`);
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <aside className="drawer glass concept-panel" aria-label={t('graph.concept')}>
      <header className="drawer-head">
        <Icon name="globe" />
        <h2 title={c?.name}>{c?.name ?? t('common.loading')}</h2>
        <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
          <Icon name="close" />
        </button>
      </header>
      {c && (
        <div className="drawer-body">
          <div className="row gap wrap">
            <AiTag />
            {c.hidden && <span className="badge muted">{t('graph.hide')}</span>}
          </div>
          {c.description && <p>{c.description}</p>}
          <div className="drawer-actions">
            <button className="btn small primary" onClick={() => void askChat()}>
              <Icon name="chat" size={14} /> {t('graph.ask')}
            </button>
            <button className="btn small ghost" onClick={() => void rename()}>
              <Icon name="edit" size={14} /> {t('graph.rename')}
            </button>
            <button className="btn small ghost" onClick={() => void update({ hidden: !c.hidden })}>
              <Icon name="eye" size={14} /> {c.hidden ? t('graph.show') : t('graph.hide')}
            </button>
          </div>
          <h3>{t('graph.sources')}</h3>
          <ul className="concept-sources">
            {c.sources.map((s) => (
              <li key={s.sourceId}>
                <RefLink r={{ sourceId: s.sourceId, sourceName: s.sourceName, chunkId: s.chunkId, loc: s.loc }} />
                {s.snippet && <p className="cite-snippet">{s.snippet}</p>}
              </li>
            ))}
          </ul>
          <h3>{t('graph.links')}</h3>
          <ul className="concept-links">
            {c.neighbors.map((n) => (
              <li key={n.edgeId} className={n.hidden ? 'muted' : ''}>
                <span className="muted small">{n.label}</span>{' '}
                <span>{n.name}</span>
                <span className="spacer" />
                <button className="icon-btn small" onClick={() => void relabel(n.edgeId, n.label)} aria-label={`${t('graph.editLabel')}: ${n.name}`} title={t('graph.editLabel')}>
                  <Icon name="edit" size={13} />
                </button>
                <button className="icon-btn small" onClick={() => void edge(n.edgeId, { hidden: !n.hidden })} aria-label={`${n.hidden ? t('graph.show') : t('graph.hide')}: ${n.name}`} title={n.hidden ? t('graph.show') : t('graph.hide')}>
                  <Icon name="eye" size={13} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

export function GraphTab({ subject }: { subject: number | null }) {
  const { t, toastError } = useApp();
  const [data, setData] = useState<GraphData | null>(null);
  const [source, setSource] = useState<number | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [hidden, setHidden] = useState(false);
  const [mode, setMode] = useState<'graph' | 'list'>(() => (prefersReducedMotion() ? 'list' : 'graph'));
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (source) q.set('source', String(source));
    else if (subject) q.set('subject', String(subject));
    if (hidden) q.set('hidden', 'true');
    get<GraphData>(`/api/graph${q.size ? `?${q}` : ''}`)
      .then(setData)
      .catch(toastError);
  }, [subject, source, hidden, toastError]);
  useEffect(load, [load]);
  useHubEvent((e) => {
    if (e.type === 'learn-job' && e.job.kind === 'graph' && e.job.state === 'done') load();
  });
  useEffect(() => {
    setSource(null);
    get<{ items: Source[] }>(`/api/sources?subject=${subject ?? 'all'}&status=ready`)
      .then((r) => setSources(r.items.slice(0, 500)))
      .catch(() => {});
  }, [subject]);
  // Fokus nach dem Schließen dorthin zurück, wo er vor dem Öffnen war (Tabellenzeile/Canvas)
  const opener = useRef<HTMLElement | null>(null);
  const select = useCallback((id: number | null) => {
    if (id !== null) opener.current = document.activeElement as HTMLElement | null;
    setSelected(id);
  }, []);
  const close = useCallback(() => {
    setSelected(null);
    const el = opener.current;
    requestAnimationFrame(() => el?.focus?.());
  }, []);

  const sorted = useMemo(() => [...(data?.nodes ?? [])].sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name)), [data]);
  return (
    <div className={`graph-tab ${selected ? 'with-panel' : ''}`}>
      <div className="toolbar">
        <div className="segmented" role="radiogroup" aria-label={t('learn.tab.graph')}>
          {(['graph', 'list'] as const).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
              {t(`graph.view.${m}`)}
            </button>
          ))}
        </div>
        <select className="input small" value={source ?? ''} onChange={(e) => setSource(Number(e.target.value) || null)} aria-label={t('gen.scope.source')}>
          <option value="">{t('graph.allSources')}</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="check-row small">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> {t('graph.hidden')}
        </label>
        <span className="spacer" />
        {data && (
          <span className="muted small">
            {data.truncated ? t('graph.truncated', { shown: data.nodes.length, total: data.total }) : t('graph.count', { nodes: data.nodes.length, edges: data.edges.length })}
          </span>
        )}
        <AiTag />
      </div>
      {data && data.nodes.length === 0 && <p className="muted pad">{t('graph.empty')}</p>}
      {data && data.nodes.length > 0 && mode === 'graph' && <GraphCanvas data={data} selected={selected} onSelect={select} />}
      {data && data.nodes.length > 0 && mode === 'list' && (
        <div className="graph-table-wrap">
          <table className="graph-table">
            <thead>
              <tr>
                <th scope="col">{t('graph.nameCol')}</th>
                <th scope="col">{t('graph.sources')}</th>
                <th scope="col">{t('graph.links')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((n) => (
                <tr key={n.id} className={n.hidden ? 'muted' : ''}>
                  <th scope="row">
                    <button className="link" onClick={() => select(n.id)} aria-current={selected === n.id ? 'true' : undefined}>
                      {n.name}
                    </button>
                  </th>
                  <td>{n.sources}</td>
                  <td>{n.degree}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected !== null && <ConceptPanel key={selected} id={selected} onClose={close} onChanged={load} />}
    </div>
  );
}
