import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initTheme } from './theme';
import { useEditor } from '../features/editor/store';
import { simulationClient } from '../workers/client';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Aparecium could not find its mount point.');

// Applied before the first paint so there is no flash of the wrong theme.
initTheme();

// Surface unexpected failures instead of leaving a blank screen.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[aparecium] unhandled rejection', event.reason);
});

// A handle for browser-based checks; the Playwright suite reads engine numbers
// through it so its assertions can be exact rather than screen-scraped.
declare global {
  interface Window {
    aparecium?: { store: typeof useEditor; simulation: typeof simulationClient };
  }
}
window.aparecium = { store: useEditor, simulation: simulationClient };

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
