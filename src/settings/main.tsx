// Settings window entry (docs/01 §1: React, separate webview, talks to the kernel only via RPC).

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { About } from './pages/About';
import { Connect } from './pages/Connect';
import { Inspector } from './pages/Inspector';
import { Pets } from './pages/Pets';
import { Plugins } from './pages/Plugins';
import './styles.css';
import { Icons, Mark, ToastHost } from './ui';

const PAGES = [
  { id: 'pets', label: '宠物', icon: Icons.pets, view: Pets },
  { id: 'connect', label: '接入', icon: Icons.link, view: Connect },
  { id: 'plugins', label: '插件', icon: Icons.puzzle, view: Plugins },
  { id: 'inspector', label: '检查器', icon: Icons.scope, view: Inspector },
  { id: 'about', label: '关于', icon: Icons.info, view: About },
] as const;

function App() {
  const [page, setPage] = useState<string>(() => {
    try {
      return localStorage.getItem('page') ?? 'pets';
    } catch {
      return 'pets';
    }
  });
  const go = (id: string) => {
    setPage(id);
    try {
      localStorage.setItem('page', id);
    } catch {
      /* not essential */
    }
  };
  const View = (PAGES.find((p) => p.id === page) ?? PAGES[0]).view;
  return (
    <div className="app">
      <nav className="side" aria-label="设置分区">
        <div className="brand">
          <Mark />
          Petween
        </div>
        {PAGES.map((p) => (
          <button key={p.id} className={`nav${p.id === page ? ' on' : ''}`} aria-current={p.id === page ? 'page' : undefined} onClick={() => go(p.id)}>
            <p.icon />
            {p.label}
          </button>
        ))}
        <div className="grow" />
      </nav>
      <main className="main">
        <View />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ToastHost>
    <App />
  </ToastHost>,
);
