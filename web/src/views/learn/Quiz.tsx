import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post } from '../../api';
import { Icon } from '../../components/Icon';
import { AiTag, RefLink } from '../../components/LearnBits';
import { Markdown } from '../../components/Markdown';
import { formatClock, formatDate } from '../../lib/format';
import { useApp, useHubEvent } from '../../store';
import type { QuizQuestion, QuizResult, Weakness } from '../../types';

type Phase = 'setup' | 'run' | 'grading' | 'result';
interface Session {
  id: number;
  mode: 'practice' | 'exam';
  timeLimitSec: number | null;
  startedAt: number;
}

function Verdict({ score }: { score: number }) {
  const { t } = useApp();
  if (score >= 0.999)
    return (
      <span className="badge ok">
        <Icon name="check" size={12} /> {t('quiz.correct')}
      </span>
    );
  if (score <= 0)
    return (
      <span className="badge err">
        <Icon name="close" size={12} /> {t('quiz.wrong')}
      </span>
    );
  return <span className="badge warn">{t('quiz.partial', { p: Math.round(score * 100) })}</span>;
}

/** Bewertung + Lösung – immer mit Quelle; bei Freitext Rubrik, Begründung und wörtliche Belege. */
function ResultBox({ res }: { res: QuizResult }) {
  const { t } = useApp();
  return (
    <div className="quiz-result" role="status">
      <div className="row gap wrap">
        <Verdict score={res.score} />
        <span className="muted small">{t('quiz.solution')}:</span>
        <strong>{res.answer === 'true' ? t('quiz.true') : res.answer === 'false' ? t('quiz.false') : res.answer}</strong>
      </div>
      {res.explanation && (
        <div className="small">
          <span className="muted">{t('quiz.explanation')}: </span>
          {res.explanation}
        </div>
      )}
      <RefLink r={res.source} />
      {res.feedback && (
        <div className="grade-box">
          <AiTag />
          <p className="small">{res.feedback.reasoning}</p>
          {res.feedback.rubric.length > 0 && (
            <>
              <span className="muted small">{t('quiz.rubric')}</span>
              <ul className="rubric">
                {res.feedback.rubric.map((r, i) => (
                  <li key={i} className={r.met ? 'ok' : 'err'}>
                    <Icon name={r.met ? 'check' : 'close'} size={13} /> {r.criterion}
                  </li>
                ))}
              </ul>
            </>
          )}
          {res.feedback.quotes.length > 0 && (
            <>
              <span className="muted small">{t('quiz.quotes')}</span>
              {res.feedback.quotes.map((q, i) => (
                <blockquote key={i} className="small">
                  „{q.text}“ {res.feedback!.refs[q.doc - 1] && <RefLink r={res.feedback!.refs[q.doc - 1]!} />}
                </blockquote>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AnswerInput({ q, value, onChange, disabled }: { q: QuizQuestion; value: string; onChange(v: string): void; disabled?: boolean }) {
  const { t } = useApp();
  if (q.type === 'mc')
    return (
      <div className="quiz-options" role="radiogroup" aria-label={t('quiz.yourAnswer')}>
        {q.options?.map((o) => (
          <label key={o} className={`radio-row option ${value === o ? 'active' : ''}`}>
            <input type="radio" name={`q-${q.id}`} checked={value === o} onChange={() => onChange(o)} disabled={disabled} />
            <span>{o}</span>
          </label>
        ))}
      </div>
    );
  if (q.type === 'tf')
    return (
      <div className="segmented" role="radiogroup" aria-label={t('quiz.yourAnswer')}>
        {(['true', 'false'] as const).map((v) => (
          <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'active' : ''} onClick={() => onChange(v)} disabled={disabled}>
            {t(v === 'true' ? 'quiz.true' : 'quiz.false')}
          </button>
        ))}
      </div>
    );
  if (q.type === 'cloze') return <input className="input" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label={t('quiz.yourAnswer')} maxLength={300} />;
  return <textarea className="input" rows={4} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label={t('quiz.yourAnswer')} maxLength={4000} />;
}

export function QuizTab({ subject }: { subject: number | null }) {
  const { t, lang, navigate, openGenerate, toastError } = useApp();
  const [phase, setPhase] = useState<Phase>('setup');
  const [mode, setMode] = useState<'practice' | 'exam'>('practice');
  const [count, setCount] = useState(10);
  const [minutes, setMinutes] = useState(15);
  const [pool, setPool] = useState<number | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [results, setResults] = useState<Record<number, QuizResult>>({});
  const [busy, setBusy] = useState(false);
  const [grading, setGrading] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [history, setHistory] = useState<{ id: number; mode: string; startedAt: number; total: number; points: number }[]>([]);
  const [weak, setWeak] = useState<Weakness[]>([]);
  const submitted = useRef(false);

  const scope = subject ? { subjectId: subject } : {};
  const loadMeta = useCallback(() => {
    post<{ count: number }>('/api/quiz/pool', { scope: subject ? { subjectId: subject } : {} })
      .then((r) => setPool(r.count))
      .catch(() => {});
    get<typeof history>('/api/quiz/history')
      .then(setHistory)
      .catch(() => {});
    get<Weakness[]>(`/api/quiz/weak${subject ? `?subject=${subject}` : ''}`)
      .then(setWeak)
      .catch(() => {});
  }, [subject]);
  useEffect(loadMeta, [loadMeta]);
  useHubEvent((e) => {
    if (e.type === 'learn-job' && e.job.kind === 'quiz' && e.job.state === 'done' && phase === 'setup') loadMeta();
  });

  const start = async () => {
    try {
      const r = await post<{ session: Session; questions: QuizQuestion[] }>('/api/quiz/sessions', { mode, scope, count, ...(mode === 'exam' ? { timeLimitSec: minutes * 60 } : {}) });
      setSession(r.session);
      setQuestions(r.questions);
      setIdx(0);
      setAnswers({});
      setResults({});
      submitted.current = false;
      setPhase('run');
    } catch (err) {
      toastError(err);
    }
  };

  const grade = useCallback(
    async (q: QuizQuestion, answer: string) => {
      const r = await post<QuizResult>(`/api/quiz/questions/${q.id}/answer`, { answer, sessionId: session?.id ?? null });
      setResults((x) => ({ ...x, [q.id]: r }));
      return r;
    },
    [session],
  );

  const finish = useCallback(async () => {
    if (submitted.current || !session) return;
    submitted.current = true;
    setPhase('grading');
    try {
      if (session.mode === 'exam') {
        // Klausur: erst am Ende bewerten (Freitext durch das Modell, nacheinander)
        for (let i = 0; i < questions.length; i++) {
          setGrading(i + 1);
          await grade(questions[i]!, answers[questions[i]!.id] ?? '');
        }
      }
      await post(`/api/quiz/sessions/${session.id}/finish`);
    } catch (err) {
      toastError(err);
    }
    setPhase('result');
    loadMeta();
  }, [session, questions, answers, grade, toastError, loadMeta]);

  // Klausur-Timer: läuft ab -> automatisch abgeben
  const deadline = session?.timeLimitSec ? session.startedAt + session.timeLimitSec * 1000 : null;
  useEffect(() => {
    if (phase !== 'run' || !deadline) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [phase, deadline]);
  useEffect(() => {
    if (phase === 'run' && deadline && now >= deadline) void finish();
  }, [now, deadline, phase, finish]);

  const q = questions[idx];
  const check = async () => {
    if (!q) return;
    setBusy(true);
    try {
      await grade(q, answers[q.id] ?? '');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'setup')
    return (
      <div className="quiz-tab">
        <section className="glass quiz-setup">
          <div className="seg-field">
            <span>{t('quiz.mode')}</span>
            <div className="segmented" role="radiogroup" aria-label={t('quiz.mode')}>
              {(['practice', 'exam'] as const).map((m) => (
                <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
                  {t(`quiz.${m}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="field-grid">
            <label className="field">
              <span>{t('quiz.count')}</span>
              <input type="number" min={1} max={100} value={count} onChange={(e) => setCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
            </label>
            {mode === 'exam' && (
              <label className="field">
                <span>{t('quiz.minutes')}</span>
                <input type="number" min={1} max={240} value={minutes} onChange={(e) => setMinutes(Math.max(1, Math.min(240, Number(e.target.value) || 1)))} />
              </label>
            )}
          </div>
          <p className="muted small">{pool === null ? '' : pool ? t('quiz.pool', { n: pool }) : t('quiz.empty')}</p>
          <div className="row gap wrap">
            <button className="btn primary" onClick={() => void start()} disabled={!pool}>
              <Icon name="send" size={15} /> {t('quiz.start')}
            </button>
            <button className="btn" onClick={() => openGenerate({ kind: 'quiz', ...(subject ? { scope: { kind: 'subject', id: subject } } : {}) })}>
              <Icon name="spark" size={15} /> {t('quiz.genMore')}
            </button>
          </div>
        </section>
        <section className="glass quiz-side" aria-labelledby="weak-title">
          <h3 id="weak-title">{t('quiz.weak')}</h3>
          {weak.length === 0 && <p className="muted small">{t('quiz.weakEmpty')}</p>}
          <ul className="weak-list">
            {weak.map((w, i) => (
              <li key={i}>
                <strong className="ellipsis">{w.topic ?? w.sourceName}</strong>
                <span className="muted small">
                  {w.sourceName && w.topic !== w.sourceName ? `${w.sourceName} · ` : ''}
                  {t('quiz.weakItem', { p: Math.round(w.avg * 100), n: w.attempts })}
                </span>
                {w.sourceId && (
                  <div className="row gap wrap">
                    <button className="btn small ghost" onClick={() => navigate(`#/library/all?source=${w.sourceId}${w.chunkId ? `&chunk=${w.chunkId}` : ''}`)}>
                      <Icon name="library" size={13} /> {t('quiz.repeatSection')}
                    </button>
                    {w.cards > 0 ? (
                      <button className="btn small" onClick={() => navigate(`#/learn/review?source=${w.sourceId}`)}>
                        <Icon name="refresh" size={13} /> {t('quiz.practiceCards', { n: w.cards })}
                      </button>
                    ) : (
                      <button className="btn small" onClick={() => openGenerate({ kind: 'cards', scope: { kind: 'source', id: w.sourceId! } })}>
                        <Icon name="spark" size={13} /> {t('quiz.makeCards')}
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {history.length > 0 && (
            <>
              <h3>{t('quiz.history')}</h3>
              <ul className="history-list small">
                {history.slice(0, 10).map((h) => (
                  <li key={h.id}>
                    <span className="muted">{formatDate(h.startedAt, lang)}</span> {t('quiz.historyItem', { mode: t(h.mode === 'exam' ? 'quiz.exam' : 'quiz.practice'), points: Math.round(h.points * 10) / 10, total: h.total })}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    );

  if (phase === 'grading')
    return (
      <div className="empty-state glass" role="status">
        <span className="spinner" aria-hidden="true" />
        <p>{session?.mode === 'exam' ? t('quiz.grading', { i: grading, n: questions.length }) : t('common.loading')}</p>
      </div>
    );

  if (phase === 'result') {
    const points = questions.reduce((n, x) => n + (results[x.id]?.score ?? 0), 0);
    return (
      <div className="quiz-run">
        <div className="row gap wrap">
          <h2>{t('quiz.result', { points: Math.round(points * 10) / 10, total: questions.length })}</h2>
          <span className="spacer" />
          <button className="btn primary" onClick={() => setPhase('setup')}>
            <Icon name="refresh" size={15} /> {t('quiz.again')}
          </button>
        </div>
        {session?.mode === 'exam' &&
          questions.map((x, i) => (
            <article key={x.id} className="glass quiz-card">
              <span className="muted small">{t('quiz.question', { i: i + 1, n: questions.length })}</span>
              <Markdown text={x.question} />
              <p className="small">
                <span className="muted">{t('quiz.yourAnswer')}: </span>
                {answers[x.id] === 'true' ? t('quiz.true') : answers[x.id] === 'false' ? t('quiz.false') : answers[x.id] || '–'}
              </p>
              {results[x.id] && <ResultBox res={results[x.id]!} />}
            </article>
          ))}
      </div>
    );
  }

  // Durchlauf
  const res = q ? results[q.id] : undefined;
  const left = deadline ? Math.max(0, Math.round((deadline - now) / 1000)) : null;
  return (
    <div className="quiz-run">
      <div className="chip-row">
        <span className="chip">{t('quiz.question', { i: idx + 1, n: questions.length })}</span>
        <span className="chip">{t(session?.mode === 'exam' ? 'quiz.exam' : 'quiz.practice')}</span>
        {left !== null && (
          <span className={`chip ${left < 60 ? 'warn' : ''}`} role="timer" aria-live="off">
            <Icon name="clock" size={13} /> {t('quiz.timeLeft', { t: formatClock(left) })}
          </span>
        )}
      </div>
      {q && (
        <article className="glass quiz-card">
          <div className="row gap wrap">
            <AiTag />
            <span className="muted small">{t(`quiz.type.${q.type}`)}</span>
            {q.topic && <span className="muted small ellipsis">· {q.topic}</span>}
          </div>
          <div className="quiz-question">
            <Markdown text={q.question} />
          </div>
          <AnswerInput q={q} value={answers[q.id] ?? ''} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} disabled={!!res} />
          {res && <ResultBox res={res} />}
          <div className="row gap wrap">
            {session?.mode === 'exam' && idx > 0 && (
              <button className="btn ghost" onClick={() => setIdx(idx - 1)}>
                {t('quiz.prev')}
              </button>
            )}
            <span className="spacer" />
            {session?.mode === 'practice' && !res && (
              <button className="btn primary" onClick={() => void check()} disabled={busy || !(answers[q.id] ?? '').trim()}>
                {busy ? <span className="spinner tiny" aria-hidden="true" /> : <Icon name="check" size={15} />} {t('quiz.check')}
              </button>
            )}
            {(session?.mode === 'exam' || res) && idx < questions.length - 1 && (
              <button className="btn primary" onClick={() => setIdx(idx + 1)}>
                {t('quiz.next')}
              </button>
            )}
            {(session?.mode === 'exam' || res) && idx === questions.length - 1 && (
              <button className="btn primary" onClick={() => void finish()}>
                {t('quiz.finish')}
              </button>
            )}
          </div>
        </article>
      )}
    </div>
  );
}
