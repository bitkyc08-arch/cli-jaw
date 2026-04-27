import { createRoot } from 'react-dom/client';
import { App } from './App';
import './manager-tokens.css';
import './styles.css';
import './manager-layout.css';
import './manager-components.css';
import './manager-emerging.css';
import './manager-persistence.css';
import './manager-polish.css';

const root = document.getElementById('manager-root');
if (!root) throw new Error('manager-root not found');

createRoot(root).render(<App />);
