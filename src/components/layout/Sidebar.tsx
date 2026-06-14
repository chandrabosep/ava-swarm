import { useState } from 'react';

type NavKey = 'portfolio' | 'agents' | 'news' | 'settings';

interface NavItem {
  key: NavKey;
  label: string;
  icon: string;
}

const ITEMS: NavItem[] = [
  { key: 'portfolio', label: 'Portfolio', icon: '◧' },
  { key: 'agents', label: 'Agents', icon: '◇' },
  { key: 'news', label: 'News', icon: '☷' },
  { key: 'settings', label: 'Settings', icon: '◉' },
];

export function Sidebar() {
  // Nav is purely visual for now — swapping main views lands when the agents
  // wiring does. We track active state locally to keep the rail interactive.
  const [active, setActive] = useState<NavKey>('portfolio');

  return (
    <aside className="w-56 shrink-0 border-r border-border h-[calc(100vh-3.5rem)] sticky top-14 px-3 py-4 flex flex-col gap-1">
      <div className="px-3 pb-3 text-[11px] uppercase tracking-wider text-fg-subtle">
        Workspace
      </div>
      {ITEMS.map((item) => (
        <button
          key={item.key}
          onClick={() => setActive(item.key)}
          className={`nav-item ${active === item.key ? 'nav-item-active' : ''}`}
        >
          <span className="text-fg-subtle w-4 text-center">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
      <div className="mt-auto px-3 pt-4 text-[11px] text-fg-subtle">
        v0.1.0 · shell
      </div>
    </aside>
  );
}
