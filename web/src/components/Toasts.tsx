import { useApp } from '../store';
import { Icon } from './Icon';

export function Toasts() {
  const { toasts, dismissToast, connected, t } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {!connected && (
        <div className="toast error">
          <Icon name="alert" />
          <span>{t('err.server')}</span>
        </div>
      )}
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.kind}`}>
          <Icon name={x.kind === 'error' ? 'alert' : x.kind === 'success' ? 'check' : 'info'} />
          <span>{x.text}</span>
          <button className="icon-btn" aria-label={t('common.close')} onClick={() => dismissToast(x.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
