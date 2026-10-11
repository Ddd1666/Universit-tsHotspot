import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, waitFor, waitForEmbeddings, waitForSource, type TestApp } from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
  const r = await app.upload('thermo.md', '# Thermodynamik\n\nDer zweite Hauptsatz besagt, dass die Entropie eines abgeschlossenen Systems nie abnimmt.');
  await waitForSource(app, r.data.source.id);
  await waitForEmbeddings(app);
});
afterAll(async () => app.close());

interface Session {
  id: number;
  title: string;
  titleLocked: boolean;
  scope: { mode: string; ids?: number[] };
  model: string | null;
}

describe('Chat-Sessions (CRUD)', () => {
  it('anlegen, auflisten, umbenennen, Wissensbereich/Modell setzen, löschen', async () => {
    const s = (await app.api<Session>('POST', '/api/chats', { scope: { mode: 'none' } })).data;
    // leerer Titel = Oberfläche zeigt lokalisiert Neuer Chat / New chat
    expect(s).toMatchObject({ title: '', titleLocked: false, scope: { mode: 'none' } });
    const renamed = (await app.api<Session>('PATCH', `/api/chats/${s.id}`, { title: 'Meine Lernsession', model: 'qwen3:4b', scope: { mode: 'subjects', ids: [1, 2] } })).data;
    expect(renamed).toMatchObject({ title: 'Meine Lernsession', titleLocked: true, model: 'qwen3:4b', scope: { mode: 'subjects', ids: [1, 2] } });
    expect((await app.api<Session[]>('GET', '/api/chats')).data.some((c) => c.id === s.id)).toBe(true);
    expect((await app.api('PATCH', `/api/chats/${s.id}`, { model: 'bad model!' })).status).toBe(400);
    expect((await app.api('DELETE', `/api/chats/${s.id}`)).status).toBe(200);
    expect((await app.api('GET', `/api/chats/${s.id}`)).status).toBe(404);
  });

  it('jede Session hat ihren eigenen, persistenten Verlauf; Löschen entfernt Nachrichten', async () => {
    const a = (await app.api<Session>('POST', '/api/chats', { scope: { mode: 'none' } })).data;
    const b = (await app.api<Session>('POST', '/api/chats', { scope: { mode: 'none' } })).data;
    await app.stream(`/api/chats/${a.id}/messages`, { content: 'Frage nur in A' });
    await app.stream(`/api/chats/${b.id}/messages`, { content: 'Frage nur in B' });
    const ma = (await app.api<{ messages: { content: string }[] }>('GET', `/api/chats/${a.id}`)).data.messages;
    const mb = (await app.api<{ messages: { content: string }[] }>('GET', `/api/chats/${b.id}`)).data.messages;
    expect(ma.map((m) => m.content)[0]).toBe('Frage nur in A');
    expect(mb.map((m) => m.content)[0]).toBe('Frage nur in B');
    expect(ma).toHaveLength(2);
    await app.api('DELETE', `/api/chats/${a.id}`);
    const left = app.hotspot.services.db.prepare('SELECT count(*) AS n FROM chat_messages WHERE session_id = ?').get(a.id) as { n: number };
    expect(left.n).toBe(0);
  });

  it('Suche über den Chat-Verlauf (Titel und Inhalte)', async () => {
    const s = (await app.api<Session>('POST', '/api/chats', { scope: { mode: 'none' } })).data;
    await app.stream(`/api/chats/${s.id}/messages`, { content: 'Wie funktioniert Photosynthese genau?' });
    const hits = (await app.api<(Session & { match?: string })[]>('GET', '/api/chats?q=photosynthese')).data;
    expect(hits.map((h) => h.id)).toContain(s.id);
    expect(hits.find((h) => h.id === s.id)!.match).toMatch(/Photosynthese/);
    expect((await app.api<Session[]>('GET', '/api/chats?q=gibtsnicht123')).data).toHaveLength(0);
  });
});

describe('RAG-Antwort mit Streaming', () => {
  it('streamt Tokens, liefert nummerierte Quellen und speichert die Antwort', async () => {
    const s = (await app.api<Session>('POST', '/api/chats', {})).data;
    const events = await app.stream(`/api/chats/${s.id}/messages`, { content: 'Was besagt der zweite Hauptsatz?' });
    const names = events.map((e) => e.event);
    expect(names[0]).toBe('start');
    expect(names[1]).toBe('meta');
    expect(names.filter((n) => n === 'token').length).toBeGreaterThan(5);
    expect(names.at(-1)).toBe('done');
    const meta = events[1]!.data as { citations: { n: number; sourceName: string; locKind: string }[]; retrieval: { mode: string } };
    expect(meta.citations[0]).toMatchObject({ n: 1, sourceName: 'thermo.md', locKind: 'lines' });
    expect(meta.retrieval.mode).toBe('hybrid');
    const done = events.at(-1)!.data as { message: { content: string; citations: { used: boolean }[]; status: string } };
    expect(done.message.content).toContain('[1]');
    expect(done.message.citations[0]!.used).toBe(true);
    const streamed = events.filter((e) => e.event === 'token').map((e) => e.data.delta).join('');
    expect(streamed.trim()).toBe(done.message.content);

    // Auto-Titel (LLM-Call im Hintergrund, Fallback = erste Frage)
    const titled = await waitFor(async () => {
      const t = (await app.api<{ session: Session }>('GET', `/api/chats/${s.id}`)).data.session.title;
      return t.startsWith('Mock:') ? t : null;
    });
    expect(titled).toMatch(/^Mock: Was besagt/);
    // Auto-Titel nutzt dieselbe num_ctx wie der Chat (sonst lädt Ollama das Modell neu)
    const titleReq = app.hotspot.mock!.requests.filter((r) => r.path === '/api/chat' && (r.body as { stream?: boolean }).stream === false).at(-1)!;
    expect((titleReq.body as { options: { num_ctx: number } }).options.num_ctx).toBe(8192);
  });

  it('Prompt enthält Dokumente als abgegrenzte Daten; Antwortsprache folgt der Frage', async () => {
    const s = (await app.api<Session>('POST', '/api/chats', {})).data;
    const events = await app.stream(`/api/chats/${s.id}/messages`, { content: 'What does the second Hauptsatz say about Entropie?' });
    const done = events.at(-1)!.data as { message: { content: string } };
    expect(done.message.content).toMatch(/^According to your documents/);
    const req = app.hotspot.mock!.requests.filter((r) => r.path === '/api/chat' && (r.body as { stream?: boolean }).stream === true).at(-1);
    const body = req!.body as { messages: { role: string; content: string }[]; options: { num_ctx: number } };
    expect(body.options.num_ctx).toBe(8192);
    const user = body.messages.filter((m) => m.role === 'user').at(-1)!.content;
    expect(user).toMatch(/^<documents>\n<document index="1" source="thermo.md"/);
  });

  it('Regenerate ersetzt die letzte Antwort', async () => {
    const s = (await app.api<Session>('POST', '/api/chats', {})).data;
    await app.stream(`/api/chats/${s.id}/messages`, { content: 'Was ist Entropie?' });
    const before = (await app.api<{ messages: { id: number }[] }>('GET', `/api/chats/${s.id}`)).data.messages;
    const events = await app.stream(`/api/chats/${s.id}/regenerate`, {});
    expect(events.at(-1)!.event).toBe('done');
    const after = (await app.api<{ messages: { id: number; role: string }[] }>('GET', `/api/chats/${s.id}`)).data.messages;
    expect(after).toHaveLength(2);
    expect(after[1]!.id).not.toBe(before[1]!.id);
  });

  it('Abbrechen speichert die Teilantwort als "abgebrochen"', async () => {
    const s = (await app.api<Session>('POST', '/api/chats', {})).data;
    let tokens = 0;
    await app.stream(`/api/chats/${s.id}/messages`, { content: 'Erkläre Entropie ausführlich' }, { abortAfter: (e) => e === 'token' && ++tokens >= 3 });
    const msg = await waitFor(async () => {
      const m = (await app.api<{ messages: { role: string; status: string; content: string }[] }>('GET', `/api/chats/${s.id}`)).data.messages.at(-1)!;
      return m.role === 'assistant' && m.status !== 'streaming' ? m : null;
    });
    expect(msg.status).toBe('aborted');
    expect(msg.content.length).toBeGreaterThan(0);
  });

  it('Thinking-Modelle: Denkschritte getrennt (natives Feld)', async () => {
    const s = (await app.api<Session>('POST', '/api/chats', { model: 'qwen3:4b' })).data;
    const events = await app.stream(`/api/chats/${s.id}/messages`, { content: 'Was ist Entropie?' });
    expect(events.some((e) => e.event === 'thinking')).toBe(true);
    const done = events.at(-1)!.data as { message: { thinking: string; content: string } };
    expect(done.message.thinking).toMatch(/prüfe/);
    expect(done.message.content).not.toMatch(/prüfe die bereitgestellten/);
  });

  it('Thinking deaktiviert: Inline-<think> wird trotzdem herausgefiltert', async () => {
    // Mock sendet bei fehlendem think-Parameter Inline-Tags; mit thinking=false wird think:false gesendet.
    await app.api('PUT', '/api/settings', { thinking: false });
    const s = (await app.api<Session>('POST', '/api/chats', { model: 'qwen3:4b' })).data;
    const events = await app.stream(`/api/chats/${s.id}/messages`, { content: 'Kurz: Entropie?' });
    const done = events.at(-1)!.data as { message: { content: string } };
    expect(done.message.content).not.toContain('<think>');
    await app.api('PUT', '/api/settings', { thinking: true });
  });
});

describe('Fehlerfälle ohne Absturz', () => {
  it('Ollama nicht erreichbar -> verständlicher Fehler, Nachricht gespeichert', async () => {
    const s = (await app.api<Session>('POST', '/api/chats', { scope: { mode: 'none' } })).data;
    app.hotspot.mock!.setDown(true);
    const events = await app.stream(`/api/chats/${s.id}/messages`, { content: 'Hallo?' });
    app.hotspot.mock!.setDown(false);
    const err = events.find((e) => e.event === 'error')!;
    expect(err.data.code).toBe('unreachable');
    expect(String(err.data.message)).toMatch(/nicht erreichbar/);
    const msgs = (await app.api<{ messages: { status: string; error: { code: string } | null }[] }>('GET', `/api/chats/${s.id}`)).data.messages;
    expect(msgs.at(-1)).toMatchObject({ status: 'error', error: { code: 'unreachable' } });
    expect((await app.api('GET', '/api/health')).status).toBe(200);
  });

  it('nicht installiertes Modell -> model_missing mit pull-Hinweis', async () => {
    const s = (await app.api<Session>('POST', '/api/chats', { scope: { mode: 'none' }, model: 'llama9:70b' })).data;
    const events = await app.stream(`/api/chats/${s.id}/messages`, { content: 'Hallo?' });
    const err = events.find((e) => e.event === 'error')!;
    expect(err.data.code).toBe('model_missing');
    expect(String(err.data.message)).toMatch(/ollama pull llama9:70b/);
  });

  it('Abbruch mitten im Ollama-Stream wird als Fehler gemeldet', async () => {
    const s = (await app.api<Session>('POST', '/api/chats', { scope: { mode: 'none' } })).data;
    const events = await app.stream(`/api/chats/${s.id}/messages`, { content: '__MOCK_ERROR__ bitte' });
    expect(events.find((e) => e.event === 'error')!.data.message).toMatch(/mock failure/);
  });

  it('Chat wird während des Streamings gelöscht -> kein Absturz', async () => {
    const s = (await app.api<Session>('POST', '/api/chats', { scope: { mode: 'none' } })).data;
    const pending = app.stream(`/api/chats/${s.id}/messages`, { content: 'Eine längere Frage zum Löschen während der Antwort' });
    await waitFor(() => app.hotspot.services.db.prepare("SELECT 1 FROM chat_messages WHERE session_id = ? AND status = 'streaming'").get(s.id));
    expect((await app.api('DELETE', `/api/chats/${s.id}`)).status).toBe(200);
    const events = await pending;
    expect(events.at(-1)!.event).toMatch(/done|error/);
    expect((await app.api('GET', '/api/health')).status).toBe(200);
    expect((await app.api('GET', `/api/chats/${s.id}`)).status).toBe(404);
  });

  it('leere oder zu lange Nachrichten werden abgelehnt', async () => {
    const s = (await app.api<Session>('POST', '/api/chats', {})).data;
    expect((await app.stream(`/api/chats/${s.id}/messages`, { content: '' }))[0]!.event).toBe('http-error');
    expect((await app.stream(`/api/chats/${s.id}/messages`, { content: 'x'.repeat(20001) }))[0]!.event).toBe('http-error');
    expect((await app.stream(`/api/chats/999999/messages`, { content: 'x' }))[0]!.data.status).toBe(404);
  });
});
