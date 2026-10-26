import type { FastifyInstance } from 'fastify';
import { HttpError } from '../library.ts';
import { OllamaError } from '../ollama/client.ts';
import { hybridSearch } from '../search/hybrid.ts';
import type { Services } from '../app.ts';
import { LEVELS, type CallOpts } from './prompts.ts';
import type { LearnKind } from './jobs.ts';
import { loadScope, parseLearnScope } from './text.ts';
import * as data from './data.ts';
import type { Rating } from './srs.ts';

const idParam = { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] } as const;
const intQ = { type: 'integer', minimum: 1 } as const;

/** HTTP-API der Lernmodi (Token/Host/Origin prüft der globale Hook wie bei allen /api-Routen). */
export function registerLearnRoutes(app: FastifyInstance, s: Services): void {
  /* ------------------------------------------------------------ Jobs */

  app.post(
    '/api/learn/jobs',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            kind: { enum: ['summary', 'cards', 'quiz', 'graph'] },
            scope: { type: 'object' },
            level: { enum: LEVELS },
            count: { type: 'integer', minimum: 1, maximum: 50 },
          },
          required: ['kind', 'scope'],
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const b = req.body as { kind: LearnKind; scope: unknown; level?: (typeof LEVELS)[number]; count?: number };
      const scope = parseLearnScope(b.scope);
      if (b.kind === 'graph' && scope.kind === 'chat') throw new HttpError(400, 'learn_invalid_scope', 'Graph nur aus Quellen');
      const { title } = loadScope(s.db, scope, 0); // prüft, ob Quelle/Fach/Chat existiert (404)
      return s.learn.enqueue(b.kind, { scope, level: b.level, count: b.count }, title);
    },
  );

  app.get('/api/learn/jobs', async () => ({ jobs: s.learn.list(), counts: s.learn.counts() }));

  app.post('/api/learn/jobs/:id/cancel', { schema: { params: idParam } }, async (req) => {
    if (!s.learn.cancel((req.params as { id: number }).id)) throw new HttpError(409, 'job_not_active', 'Job läuft nicht (mehr)');
    return { ok: true };
  });

  app.post('/api/learn/jobs/:id/retry', { schema: { params: idParam } }, async (req) => {
    if (!s.learn.retry((req.params as { id: number }).id)) throw new HttpError(409, 'job_not_retryable', 'Job kann nicht erneut gestartet werden');
    return { ok: true };
  });

  /** Überschriften einer Quelle (Auswahl "Abschnitt") */
  app.get('/api/learn/sections/:id', { schema: { params: idParam } }, async (req) =>
    (s.db.prepare('SELECT heading, count(*) AS chunks FROM chunks WHERE source_id = ? AND heading IS NOT NULL GROUP BY heading ORDER BY min(ord) LIMIT 300').all((req.params as { id: number }).id)),
  );

  /* ------------------------------------------------------------ Notizen */

  app.get('/api/notes', { schema: { querystring: { type: 'object', properties: { subject: intQ } } } }, async (req) => data.listNotes(s.db, (req.query as { subject?: number }).subject));

  app.post(
    '/api/notes',
    {
      schema: {
        body: {
          type: 'object',
          properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', maxLength: data.LIMITS_TEXT.noteBody }, subjectId: { type: ['integer', 'null'] } },
          required: ['title', 'body'],
          additionalProperties: false,
        },
      },
    },
    async (req) => data.createNote(s.db, req.body as { title: string; body: string; subjectId?: number | null }),
  );

  app.get('/api/notes/:id', { schema: { params: idParam } }, async (req) => data.getNote(s.db, (req.params as { id: number }).id));

  app.patch(
    '/api/notes/:id',
    {
      schema: {
        params: idParam,
        body: { type: 'object', properties: { title: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: data.LIMITS_TEXT.noteBody } }, additionalProperties: false },
      },
    },
    async (req) => data.updateNote(s.db, (req.params as { id: number }).id, req.body as { title?: string; body?: string }),
  );

  app.delete('/api/notes/:id', { schema: { params: idParam } }, async (req) => {
    data.deleteNote(s.db, (req.params as { id: number }).id);
    return { ok: true };
  });

  app.get('/api/notes/:id/export', { schema: { params: idParam } }, async (req) => data.exportNote(s.db, (req.params as { id: number }).id, s.settings.get().language));

  /* ------------------------------------------------------------ Karten + Wiederholung */

  const cardTypes = { enum: ['qa', 'cloze', 'image'] } as const;

  app.get(
    '/api/cards',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { status: { enum: ['draft', 'active', 'suspended'] }, subject: intQ, source: intQ, job: intQ, q: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 500 } },
        },
      },
    },
    async (req) => {
      const q = req.query as { status?: data.CardStatus; subject?: number; source?: number; job?: number; q?: string; limit?: number };
      return data.listCards(s.db, { status: q.status, subjectId: q.subject, sourceId: q.source, jobId: q.job, q: q.q, limit: q.limit });
    },
  );

  app.post(
    '/api/cards',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            type: cardTypes,
            front: { type: 'string', minLength: 1, maxLength: data.LIMITS_TEXT.cardFront },
            back: { type: 'string', maxLength: data.LIMITS_TEXT.cardBack },
            subjectId: { type: ['integer', 'null'] },
            sourceId: { type: ['integer', 'null'] },
          },
          required: ['type', 'front'],
          additionalProperties: false,
        },
      },
    },
    async (req) => data.createCard(s.db, req.body as Parameters<typeof data.createCard>[1]),
  );

  app.patch(
    '/api/cards/:id',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          properties: {
            type: cardTypes,
            front: { type: 'string', minLength: 1, maxLength: data.LIMITS_TEXT.cardFront },
            back: { type: 'string', maxLength: data.LIMITS_TEXT.cardBack },
            status: { enum: ['draft', 'active', 'suspended'] },
            subjectId: { type: ['integer', 'null'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => data.updateCard(s.db, (req.params as { id: number }).id, req.body as Parameters<typeof data.updateCard>[2]),
  );

  app.delete('/api/cards/:id', { schema: { params: idParam } }, async (req) => {
    data.deleteCard(s.db, (req.params as { id: number }).id);
    return { ok: true };
  });

  app.post(
    '/api/cards/bulk',
    {
      schema: {
        body: {
          type: 'object',
          properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 500 }, action: { enum: ['accept', 'discard', 'suspend', 'activate'] } },
          required: ['ids', 'action'],
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const b = req.body as { ids: number[]; action: 'accept' | 'discard' | 'suspend' | 'activate' };
      return { changed: data.bulkCards(s.db, b.ids, b.action) };
    },
  );

  app.post(
    '/api/cards/:id/review',
    { schema: { params: idParam, body: { type: 'object', properties: { rating: { type: 'integer', minimum: 1, maximum: 4 } }, required: ['rating'], additionalProperties: false } } },
    async (req) => data.reviewCard(s.db, (req.params as { id: number }).id, (req.body as { rating: Rating }).rating),
  );

  app.get('/api/srs/due', { schema: { querystring: { type: 'object', properties: { subject: intQ, source: intQ, limit: { type: 'integer', minimum: 1, maximum: 500 } } } } }, async (req) => {
    const q = req.query as { subject?: number; source?: number; limit?: number };
    return data.dueCards(s.db, { subjectId: q.subject, sourceId: q.source, limit: q.limit });
  });

  app.get('/api/srs/stats', { schema: { querystring: { type: 'object', properties: { subject: intQ } } } }, async (req) => data.srsStats(s.db, (req.query as { subject?: number }).subject));

  /* ------------------------------------------------------------ Quiz */

  const quizScope = {
    type: 'object',
    properties: { subjectId: { type: 'integer', minimum: 1 }, sourceIds: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 500 } },
    additionalProperties: false,
  } as const;

  app.post('/api/quiz/pool', { schema: { body: { type: 'object', properties: { scope: quizScope }, required: ['scope'] } } }, async (req) => ({
    count: data.poolSize(s.db, (req.body as { scope: data.QuizScope }).scope),
  }));

  app.post(
    '/api/quiz/sessions',
    {
      schema: {
        body: {
          type: 'object',
          properties: { mode: { enum: ['practice', 'exam'] }, scope: quizScope, count: { type: 'integer', minimum: 1, maximum: 100 }, timeLimitSec: { type: 'integer', minimum: 30, maximum: 4 * 3600 } },
          required: ['mode', 'scope', 'count'],
          additionalProperties: false,
        },
      },
    },
    async (req) => data.startSession(s.db, req.body as Parameters<typeof data.startSession>[1]),
  );

  app.post('/api/quiz/sessions/:id/finish', { schema: { params: idParam } }, async (req) => data.finishSession(s.db, (req.params as { id: number }).id));

  app.get('/api/quiz/history', async () => data.quizHistory(s.db));

  app.get('/api/quiz/weak', { schema: { querystring: { type: 'object', properties: { subject: intQ } } } }, async (req) => data.weaknesses(s.db, (req.query as { subject?: number }).subject));

  /** Interaktiver Modellaufruf (Bewertung): hat Vorrang wie ein Chat – Hintergrundjobs pausieren währenddessen. */
  const interactive = async <T>(fn: (o: CallOpts) => Promise<T>): Promise<T> => {
    const end = s.scheduler.chatStarted();
    try {
      const st = s.settings.get();
      let think: boolean | undefined;
      try {
        if ((await s.client.capabilities(st.chatModel)).includes('thinking')) think = false;
      } catch {
        /* egal */
      }
      return await fn({ client: s.client, model: st.chatModel, numCtx: st.numCtx, think, signal: AbortSignal.timeout(5 * 60_000) });
    } catch (err) {
      if (err instanceof OllamaError) {
        if (err.code === 'model_missing') throw new HttpError(409, 'model_missing', err.message, s.settings.get().chatModel);
        if (err.code === 'oom') throw new HttpError(503, 'learn_oom', err.message);
        if (err.code === 'unreachable') throw new HttpError(503, 'ollama_unreachable', err.message);
        if (err.code === 'timeout' || err.code === 'aborted') throw new HttpError(504, 'ollama_timeout', err.message);
        // Ollama erreichbar, meldet aber einen Fehler (z. B. HTTP 500) – nicht als "nicht erreichbar" ausgeben
        throw new HttpError(502, 'ollama_error', err.message, err.message.slice(0, 200));
      }
      if ((err as { code?: string }).code === 'learn_invalid_output') throw new HttpError(502, 'learn_invalid_output', (err as Error).message);
      throw err;
    } finally {
      end();
    }
  };

  /** Antwort bewerten: geschlossen lokal, Freitext vom Modell gegen die Quellen. */
  const gradeAnswer = async (q: data.QuestionRow, answer: string): Promise<{ score: number; feedback: Awaited<ReturnType<typeof data.gradeShort>> | null }> => {
    if (q.type !== 'short') return { score: data.gradeClosed(q, answer), feedback: null };
    if (!answer.trim()) return { score: 0, feedback: null };
    const feedback = await data.gradeShort(s.db, q, answer, {
      call: interactive,
      lang: s.settings.get().language,
      numCtx: s.settings.get().numCtx,
      search: async (text, ids) => (await hybridSearch({ db: s.db, vectors: s.vectors, client: s.searchClient() }, text, { scope: ids ? { mode: 'sources', ids } : { mode: 'all' }, limit: 4 })).hits,
    });
    return { score: feedback.score, feedback };
  };

  app.post(
    '/api/quiz/questions/:id/answer',
    {
      schema: {
        params: idParam,
        body: { type: 'object', properties: { answer: { type: 'string', maxLength: 4000 }, sessionId: { type: ['integer', 'null'] } }, required: ['answer'], additionalProperties: false },
      },
    },
    async (req) => {
      const q = data.getQuestion(s.db, (req.params as { id: number }).id);
      const b = req.body as { answer: string; sessionId?: number | null };
      // Regeln je Sitzung: Frage gehört dazu, nur eine Antwort je Frage, Klausur nur über die Abgabe
      let attempt: ReturnType<typeof data.getAttempt>;
      if (b.sessionId) {
        const session = data.sessionFor(s.db, b.sessionId, q.id, true);
        attempt = data.getAttempt(s.db, b.sessionId, q.id);
        // ausstehende Freitext-Bewertung darf auch nach Abschluss nachgeholt werden ("Bewertung wiederholen")
        if (session.finished_at && !attempt?.pending) throw new HttpError(409, 'quiz_finished', 'Quiz ist bereits abgeschlossen');
        if (attempt && !attempt.pending) throw new HttpError(409, 'quiz_already_answered', 'Diese Frage wurde bereits beantwortet');
        if (!attempt && session.mode === 'exam') throw new HttpError(409, 'quiz_not_submitted', 'Klausur zuerst abgeben');
      } else if (data.inOpenExam(s.db, q.id)) throw new HttpError(409, 'quiz_exam_running', 'Frage gehört zu einer laufenden Klausur');
      const answer = attempt ? attempt.answer : b.answer;
      const { score, feedback } = await gradeAnswer(q, answer);
      // nach dem Warten auf das Modell: parallele Doppelantwort/-bewertung -> 409 (nicht 500)
      if (attempt) {
        if (!data.updateAttempt(s.db, attempt.id, score, feedback)) throw new HttpError(409, 'quiz_already_answered', 'Diese Frage wurde bereits bewertet');
      } else data.recordAttempt(s.db, q.id, b.sessionId ?? null, answer, score, feedback);
      return { score, answer: q.answer, explanation: q.explanation, source: data.questionRef(q, s.db), feedback };
    },
  );

  // Ausstehende Freitext-Bewertungen einer (auch abgeschlossenen) Sitzung nachholen – z. B. nachdem Ollama wieder läuft
  app.post('/api/quiz/sessions/:id/regrade', { schema: { params: idParam } }, async (req) => {
    const id = (req.params as { id: number }).id;
    data.sessionFor(s.db, id, undefined, true);
    let graded = 0;
    for (const p of data.pendingAttempts(s.db, id)) {
      const { score, feedback } = await gradeAnswer(data.getQuestion(s.db, p.questionId), p.answer);
      if (data.updateAttempt(s.db, p.id, score, feedback)) graded++;
    }
    return { graded, pending: data.pendingAttempts(s.db, id).length };
  });

  // Klausur abgeben: alle Antworten auf einmal; Zeitlimit wird beim Abgeben geprüft, Freitext danach einzeln bewertet
  app.post(
    '/api/quiz/sessions/:id/submit',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          properties: {
            answers: {
              type: 'array',
              maxItems: 100,
              items: { type: 'object', properties: { questionId: { type: 'integer', minimum: 1 }, answer: { type: 'string', maxLength: 4000 } }, required: ['questionId', 'answer'], additionalProperties: false },
            },
          },
          required: ['answers'],
          additionalProperties: false,
        },
      },
    },
    async (req) => data.submitExam(s.db, (req.params as { id: number }).id, (req.body as { answers: { questionId: number; answer: string }[] }).answers),
  );

  /* ------------------------------------------------------------ Wissensgraph */

  app.get(
    '/api/graph',
    { schema: { querystring: { type: 'object', properties: { subject: intQ, source: intQ, hidden: { type: 'boolean' } } } } },
    async (req) => {
      const q = req.query as { subject?: number; source?: number; hidden?: boolean };
      return data.graphData(s.db, { subjectId: q.subject, sourceId: q.source, includeHidden: q.hidden });
    },
  );

  app.get('/api/graph/concepts/:id', { schema: { params: idParam } }, async (req) => data.conceptDetail(s.db, (req.params as { id: number }).id));

  app.patch(
    '/api/graph/concepts/:id',
    {
      schema: {
        params: idParam,
        body: { type: 'object', properties: { name: { type: 'string', maxLength: 80 }, description: { type: 'string', maxLength: 400 }, hidden: { type: 'boolean' } }, additionalProperties: false },
      },
    },
    async (req) => data.updateConcept(s.db, (req.params as { id: number }).id, req.body as { name?: string; description?: string; hidden?: boolean }),
  );

  app.patch(
    '/api/graph/edges/:id',
    { schema: { params: idParam, body: { type: 'object', properties: { label: { type: 'string', maxLength: 60 }, hidden: { type: 'boolean' } }, additionalProperties: false } } },
    async (req) => {
      data.updateEdge(s.db, (req.params as { id: number }).id, req.body as { label?: string; hidden?: boolean });
      return { ok: true };
    },
  );
}
