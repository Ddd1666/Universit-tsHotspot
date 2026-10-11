import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, waitFor, waitForEmbeddings, waitForSource, type TestApp } from './helpers.ts';

let apps: TestApp[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
});
async function start() {
  const a = await startTestApp();
  apps.push(a);
  return a;
}

const DOC = Array.from({ length: 40 }, (_, i) => `## Abschnitt ${i}\n\nEntropie und Thermodynamik Absatz ${i}. ${'Wärme fließt vom warmen zum kalten Körper. '.repeat(8)}`).join('\n\n');

/** Alle gespeicherten Vektoren haben die Dimension des Index (meta) – keine gemischten Dimensionen. */
function vectorLengths(app: TestApp): number[] {
  const rows = app.hotspot.services.db.prepare('SELECT DISTINCT length(vec) / 4 AS d FROM embeddings').all() as { d: number }[];
  return rows.map((r) => r.d);
}

async function reindexDuringBatch(app: TestApp, opts: { warmFirst: boolean }) {
  const mock = app.hotspot.mock!;
  if (opts.warmFirst) {
    const a = await app.upload('erst.md', '# Vorab\n\nSchon eingebettet mit nomic.');
    await waitForSource(app, a.data.source.id);
    await waitForEmbeddings(app);
    expect(app.hotspot.services.vectors.info()).toMatchObject({ model: 'nomic-embed-text', dim: 768 });
  }
  mock.setEmbedDelay(400);
  const before = mock.requests.filter((r) => r.path === '/api/embed').length;
  const up = await app.upload('lang.md', DOC);
  await waitForSource(app, up.data.source.id);
  // warten, bis ein Batch des alten Modells unterwegs ist
  await waitFor(() => mock.requests.filter((r) => r.path === '/api/embed' && (r.body as { model: string }).model === 'nomic-embed-text').length > before);
  await app.api('PUT', '/api/settings', { embeddingModel: 'all-minilm' });
  const r = await app.api('POST', '/api/index/reindex');
  expect(r.status).toBe(200);
  mock.setEmbedDelay(0);
  const done = await waitForEmbeddings(app);
  expect(done).toMatchObject({ indexModel: 'all-minilm', indexDim: 384, failed: 0 });
  expect(vectorLengths(app)).toEqual([384]);
  // Vektorsuche liefert weiterhin Treffer (früher: still 0 Treffer bei gemischten Dimensionen)
  const row = app.hotspot.services.db.prepare('SELECT chunk_id, vec FROM embeddings LIMIT 1').get() as { chunk_id: number; vec: Uint8Array };
  const q = new Float32Array(new Uint8Array(row.vec).buffer);
  const hits = app.hotspot.services.vectors.search(q, 3, null);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.score).toBeGreaterThan(0.95); // Selbstähnlichkeit (gleichlautende Abschnitte können gleichauf liegen)
}

describe('Re-Index während laufendem Embedding-Batch', () => {
  it('verwirft den Batch des alten Modells (Index existiert schon)', async () => {
    await reindexDuringBatch(await start(), { warmFirst: true });
  });

  it('verwirft den Batch auch beim allerersten Batch (Dimension noch leer)', async () => {
    const app = await start();
    expect(app.hotspot.services.vectors.info().dim).toBeNull();
    await reindexDuringBatch(app, { warmFirst: false });
  });
});

describe('Konsistenz der Vektordimension', () => {
  it('Vektoren mit falscher Dimension werden entfernt und neu eingebettet', async () => {
    const app = await start();
    const up = await app.upload('a.md', '# A\n\nVektoren und Matrizen.');
    await waitForSource(app, up.data.source.id);
    await waitForEmbeddings(app);
    const { db, vectors } = app.hotspot.services;
    const chunk = db.prepare('SELECT id, source_id FROM chunks LIMIT 1').get() as { id: number; source_id: number };
    // Altlast simulieren: Vektor mit falscher Länge
    db.prepare('UPDATE embeddings SET vec = ? WHERE chunk_id = ?').run(new Uint8Array(new Float32Array(10).buffer), chunk.id);
    vectors.invalidate();
    expect(vectors.repair()).toBe(1);
    expect((db.prepare('SELECT embed_state FROM chunks WHERE id = ?').get(chunk.id) as { embed_state: number }).embed_state).toBe(0);
    app.hotspot.services.embed.notify();
    await waitFor(() => (app.hotspot.services.embed.status().pending === 0 ? true : null));
    expect(vectorLengths(app)).toEqual([768]);
    expect(vectors.search(new Float32Array(768).fill(0.1), 5, null).length).toBeGreaterThan(0);
  });

  it('upsert lehnt Vektoren mit falscher Dimension ab', async () => {
    const app = await start();
    const up = await app.upload('b.md', '# B\n\nText.');
    await waitForSource(app, up.data.source.id);
    await waitForEmbeddings(app);
    const { db, vectors } = app.hotspot.services;
    const chunk = db.prepare('SELECT id, source_id FROM chunks LIMIT 1').get() as { id: number; source_id: number };
    expect(() => vectors.upsert([{ chunkId: chunk.id, sourceId: chunk.source_id, vector: new Float32Array(12) }])).toThrow(/dimension/i);
  });
});
