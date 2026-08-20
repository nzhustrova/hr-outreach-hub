import React from 'react';

// Settings стоит отдельно и внизу (просьба Ольги 13.08): это не шаг работы, а место,
// куда заходят изредка — держать его в одном ряду с ежедневными вкладками сбивает.
const TABS = [
  { id: 'search', label: 'Search', icon: '🔍', enabled: true },
  { id: 'contacts', label: 'Contacts', icon: '🗂️', enabled: true },
  { id: 'campaigns', label: 'Campaigns', icon: '📮', enabled: true },
  { id: 'inbox', label: 'Inbox', icon: '💬', enabled: true },
  { id: 'analytics', label: 'Analytics', icon: '📊', enabled: false },
];

const SETTINGS = { id: 'settings', label: 'Settings', icon: '⚙️', enabled: true };

export default function Sidebar({ active, onSelect }) {
  const item = (t) => (
    <button
      key={t.id}
      className={`nav-item ${active === t.id ? 'active' : ''} ${t.enabled ? '' : 'disabled'}`}
      onClick={() => t.enabled && onSelect(t.id)}
      title={t.enabled ? t.label : `${t.label} — coming soon`}
    >
      <span className="nav-icon">{t.icon}</span>
      <span className="nav-label">{t.label}</span>
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="logo">OH</div>
      <nav>{TABS.map(item)}</nav>
      <div className="sidebar-bottom">
        {item(SETTINGS)}
        <div className="sidebar-footer">Outreach Hub</div>
      </div>
    </aside>
  );
}
