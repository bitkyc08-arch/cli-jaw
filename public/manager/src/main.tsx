import { createRoot } from 'react-dom/client';
import { App } from './App';
import './manager-tokens.css';
import './styles.css';
import './manager-layout.css';
import './manager-components.css';
import './manager-emerging.css';
import './manager-persistence.css';
import './manager-profiles.css';
import './manager-polish.css';
import './manager-p0-1-1.css';
import './manager-dashboard-settings.css';
import 'katex/dist/katex.min.css';
import './manager-notes.css';
import './manager-dashboard-board.css';
import './manager-dashboard-board-stages.css';
import './manager-dashboard-board-interactions.css';
import './manager-help.css';
import './manager-dashboard-schedule.css';
import './settings-shell.css';
import './settings-controls.css';
import './settings-agent.css';

const root = document.getElementById('manager-root');
if (!root) throw new Error('manager-root not found');

createRoot(root).render(<App />);
