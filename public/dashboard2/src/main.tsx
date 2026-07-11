import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/base.css';

const rootEl = document.getElementById('dashboard2-root');
if (!rootEl) throw new Error('dashboard2 root element missing');
createRoot(rootEl).render(<App />);
