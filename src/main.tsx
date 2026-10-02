import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { APP_NAME } from './config/app';
import { bindSettingsToRoot, useSettings } from './stores/settings';
import './styles/tokens.css';

document.title = APP_NAME;

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element');
}

async function start(root: HTMLElement): Promise<void> {
  // Theme and glass mode go on <html> before the first render, so the UI never flashes in the wrong theme. `load`
  // never rejects: if the backend does not answer, the defaults (follow the OS) apply.
  bindSettingsToRoot(document.documentElement);
  await useSettings.getState().load();

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start(container);
