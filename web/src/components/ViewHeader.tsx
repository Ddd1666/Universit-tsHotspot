import type { ReactNode } from 'react';
import { useApp } from '../store';
import { Icon } from './Icon';

export function ViewHeader({ title, children, icon }: { title: ReactNode; children?: ReactNode; icon?: string }) {
  const { sidebarOpen, setSidebarOpen, t } = useApp();
  return (
    <header className="view-header">
      {!sidebarOpen && (
        <button className="icon-btn" onClick={() => setSidebarOpen(true)} aria-label={t('nav.expand')} title={t('nav.expand')}>
          <Icon name="menu" />
        </button>
      )}
      {icon && <Icon name={icon} className="view-icon" />}
      <div className="view-title">{title}</div>
      <div className="view-actions">{children}</div>
    </header>
  );
}
