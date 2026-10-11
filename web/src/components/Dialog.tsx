import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useApp } from '../store';

/** Modaler Bestätigungs-/Eingabe-Dialog mit Fokusfalle und Esc. */
export function Dialog() {
  const { dialog, closeDialog, t } = useApp();
  const [value, setValue] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!dialog) return;
    prevFocus.current = document.activeElement as HTMLElement | null;
    setValue(dialog.input?.value ?? '');
    const id = requestAnimationFrame(() => {
      const el = boxRef.current?.querySelector<HTMLElement>('input, [data-autofocus], button.primary, button');
      el?.focus();
      if (el instanceof HTMLInputElement) el.select();
    });
    return () => {
      cancelAnimationFrame(id);
      // Fokus erst nach dem aktuellen Tastenereignis zurückgeben – sonst löst dasselbe Enter
      // den Opener-Button erneut aus und der Dialog öffnet sich sofort wieder
      const el = prevFocus.current;
      setTimeout(() => el?.focus?.(), 0);
    };
  }, [dialog]);

  if (!dialog) return null;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeDialog(null);
    }
    if (e.key === 'Tab' && boxRef.current) {
      const f = boxRef.current.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])');
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

  const submit = () => {
    if (dialog.input) {
      if (value.trim()) closeDialog(value.trim());
    } else closeDialog(true);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeDialog(null)}>
      <div className="dialog glass" role="dialog" aria-modal="true" aria-labelledby="dlg-title" ref={boxRef} onKeyDown={onKey}>
        <h2 id="dlg-title">{dialog.title}</h2>
        {dialog.message && <p className="dialog-msg">{dialog.message}</p>}
        {dialog.input && (
          <label className="field">
            <span>{dialog.input.label}</span>
            <input
              value={value}
              maxLength={120}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </label>
        )}
        <div className="dialog-actions">
          <button className="btn ghost" onClick={() => closeDialog(null)}>
            {t('common.cancel')}
          </button>
          {dialog.choices ? (
            dialog.choices.map((c) => (
              <button key={c.id} className={c.danger ? 'btn danger' : 'btn primary'} onClick={() => closeDialog(c.id)}>
                {c.label}
              </button>
            ))
          ) : (
            <button
              className={dialog.danger ? 'btn danger' : 'btn primary'}
              onClick={submit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
              data-autofocus
            >
              {dialog.confirmLabel ?? t('common.confirm')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
