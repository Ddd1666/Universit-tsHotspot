import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { get, post } from '../api';
import { formatBytes, SUBJECT_COLORS } from '../lib/format';
import { useApp } from '../store';
import type { Diagnostics, Subject } from '../types';
import { CopyCmd } from './CopyCmd';
import { Icon } from './Icon';

const STEPS = ['welcome', 'ollama', 'data', 'media', 'subject', 'done'] as const;
type Step = (typeof STEPS)[number];

/**
 * Erststart-Assistent: prüft Ollama + Modelle (nur kopierbare Befehle, nie automatisch laden), Datenordner,
 * optional Medien-Werkzeuge, legt ein erstes Fach an, erklärt die Kernfunktionen. Jederzeit überspringbar,
 * später über Einstellungen/Diagnose/Strg+K wieder aufrufbar.
 */
export function Wizard() {
  const { t, lang, setWizardOpen, updateSettings, settings, subjects, toastError, navigate } = useApp();
  const [step, setStep] = useState<Step>('welcome');
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [checking, setChecking] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(SUBJECT_COLORS[0]!);
  const [created, setCreated] = useState<Subject | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const idx = STEPS.indexOf(step);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      await post('/api/ollama/refresh').catch(() => {});
      setDiag(await get<Diagnostics>('/api/diagnostics'));
    } catch (err) {
      toastError(err);
    } finally {
      setChecking(false);
    }
  }, [toastError]);
  useEffect(() => void check(), [check]);

  // Fokus in den Dialog (und bei jedem Schrittwechsel auf die Überschrift)
  useEffect(() => {
    boxRef.current?.querySelector<HTMLElement>('h2')?.focus();
  }, [step]);

  const finish = async (go?: string) => {
    setWizardOpen(false);
    if (!settings.onboardingDone) await updateSettings({ onboardingDone: true }).catch(() => {});
    if (go) navigate(go);
  };

  const createSubject = async () => {
    try {
      setCreated(await post<Subject>('/api/subjects', { name: name.trim(), color }));
      setStep('done');
    } catch (err) {
      toastError(err);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      void finish();
    }
    if (e.key === 'Tab' && boxRef.current) {
      const f = boxRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input, a[href], [tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const status = (ok: boolean | null, okText: string, badText: string) => (
    <span className={`badge ${ok ? 'ok' : ok === null ? 'muted' : 'warn'}`}>
      <Icon name={ok ? 'check' : 'alert'} size={12} /> {ok ? okText : badText}
    </span>
  );

  let body;
  switch (step) {
    case 'welcome':
      body = (
        <>
          <p>{t('wiz.welcomeText')}</p>
          <ul className="wiz-features">
            <li>
              <Icon name="upload" /> <span>{t('wiz.f1')}</span>
            </li>
            <li>
              <Icon name="chat" /> <span>{t('wiz.f2')}</span>
            </li>
            <li>
              <Icon name="brain" /> <span>{t('wiz.f3')}</span>
            </li>
            <li>
              <Icon name="shield" /> <span>{t('wiz.f4')}</span>
            </li>
          </ul>
        </>
      );
      break;
    case 'ollama':
      body = !diag ? (
        <p className="muted">{t('common.loading')}</p>
      ) : (
        <>
          <div className="row gap wrap">
            {status(diag.ollama.reachable, t('wiz.ollamaOk', { v: diag.ollama.version ?? '?' }), t('wiz.ollamaOff'))}
            {diag.app.mock && <span className="badge warn">MOCK</span>}
          </div>
          {!diag.ollama.reachable && (
            <div className="help-box">
              <strong>{t('set.ollamaHelpTitle')}</strong>
              <ol>
                <li>{t('set.ollamaHelp1')}</li>
                <li>{t('set.ollamaHelp2')}</li>
                <li>{t('set.ollamaHelp3')}</li>
              </ol>
            </div>
          )}
          <h3>{t('wiz.models')}</h3>
          <ul className="wiz-checks">
            {diag.ollama.required.map((r) => (
              <li key={r.model}>
                <div className="row gap wrap">
                  <strong>{r.roles.map((x) => t(`wiz.role.${x}`)).join(' + ')}</strong>
                  <span className="mono">{r.model}</span>
                  <span className="spacer" />
                  {status(r.installed, t('wiz.installed'), r.installed === null ? t('wiz.unknown') : t('wiz.missing'))}
                </div>
                {r.installed === false && <CopyCmd cmd={`ollama pull ${r.model}`} />}
              </li>
            ))}
          </ul>
          <p className="muted small">{t('wiz.noAutoPull')}</p>
        </>
      );
      break;
    case 'data':
      body = !diag ? (
        <p className="muted">{t('common.loading')}</p>
      ) : (
        <>
          <CopyCmd cmd={diag.dataDir.path} wrap />
          <ul className="wiz-checks">
            <li className="row gap wrap">
              {status(diag.dataDir.writable, t('wiz.writable'), t('wiz.notWritable'))}
              {diag.dataDir.freeBytes !== null && <span className="muted small">{t('wiz.free', { size: formatBytes(diag.dataDir.freeBytes, lang) })}</span>}
            </li>
            {diag.dataDir.synced && (
              <li className="notice warn" role="note">
                <Icon name="alert" size={16} /> {t('wiz.synced')}
              </li>
            )}
          </ul>
          <p className="muted small">{t('wiz.dataText', { h: settings.backupIntervalHours || '–', n: settings.backupKeep })}</p>
        </>
      );
      break;
    case 'media':
      body = !diag ? (
        <p className="muted">{t('common.loading')}</p>
      ) : (
        <>
          <p>{t('wiz.mediaText')}</p>
          <ul className="wiz-checks">
            <li className="row gap wrap">
              <strong>ffmpeg</strong>
              <span className="spacer" />
              {status(diag.tools.ffmpeg, t('wiz.installed'), t('wiz.optionalMissing'))}
            </li>
            <li className="row gap wrap">
              <strong>whisper.cpp</strong>
              <span className="spacer" />
              {status(diag.tools.whisper && diag.tools.whisperModels.length > 0, t('wiz.installed'), t('wiz.optionalMissing'))}
            </li>
          </ul>
          <button className="btn small ghost" onClick={() => void finish('#/settings')}>
            <Icon name="settings" size={14} /> {t('wiz.toMedia')}
          </button>
        </>
      );
      break;
    case 'subject':
      body = (
        <>
          {subjects.length > 0 && <p className="muted">{t('wiz.hasSubjects', { n: subjects.length })}</p>}
          <form
          className="subject-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void createSubject();
          }}
        >
          <label className="field">
            <span>{t('lib.subjectName')}</span>
            <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t('wiz.subjectPlaceholder')} />
          </label>
          <div className="swatches" role="radiogroup" aria-label={t('lib.subjectColor')}>
            {SUBJECT_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={c} className={`swatch ${c === color ? 'active' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
          <button type="submit" className="btn small primary" disabled={!name.trim()}>
            <Icon name="plus" size={14} /> {t('lib.addSubject')}
          </button>
          </form>
        </>
      );
      break;
    default:
      body = (
        <>
          {created && (
            <p className="ok">
              <Icon name="check" size={15} /> {t('wiz.subjectCreated', { name: created.name })}
            </p>
          )}
          <ol className="wiz-guide">
            <li>{t('wiz.g1')}</li>
            <li>{t('wiz.g2')}</li>
            <li>{t('wiz.g3')}</li>
            <li>{t('wiz.g4')}</li>
          </ol>
          <p className="muted small">{t('wiz.reopen')}</p>
        </>
      );
  }

  return (
    <div className="overlay wizard-overlay">
      <div className="dialog wizard glass" role="dialog" aria-modal="true" aria-labelledby="wiz-title" ref={boxRef} onKeyDown={onKey}>
        <div className="wiz-progress" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span key={s} className={i <= idx ? 'on' : ''} />
          ))}
        </div>
        <p className="muted small" aria-live="polite">
          {t('wiz.stepOf', { n: idx + 1, total: STEPS.length })}
        </p>
        <h2 id="wiz-title" tabIndex={-1}>
          {t(`wiz.title.${step}`)}
        </h2>
        <div className="wiz-body">{body}</div>
        <div className="dialog-actions">
          <button className="btn ghost" onClick={() => void finish()}>
            {step === 'done' ? t('common.close') : t('wiz.skip')}
          </button>
          <span className="spacer" />
          {(step === 'ollama' || step === 'data' || step === 'media') && (
            <button className="btn ghost" onClick={() => void check()} disabled={checking}>
              <Icon name="refresh" size={14} /> {t('wiz.recheck')}
            </button>
          )}
          {idx > 0 && step !== 'done' && (
            <button className="btn" onClick={() => setStep(STEPS[idx - 1]!)}>
              {t('wiz.back')}
            </button>
          )}
          {step === 'done' ? (
            <button className="btn primary" onClick={() => void finish('#/library')}>
              {t('wiz.start')}
            </button>
          ) : (
            <button className="btn primary" onClick={() => setStep(STEPS[idx + 1]!)}>
              {step === 'subject' ? t('wiz.later') : t('wiz.next')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
