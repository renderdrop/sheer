import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { APP_NAME } from './config/app';
import { bindSettingsToRoot, loadSettings, watchOsTransparency } from './stores/settings';
import './styles/tokens.css';

document.title = APP_NAME;

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element');
}

// The window never waits for the backend: it renders at once with the defaults (follow the OS, glass on) and the
// saved settings are applied to <html> when they arrive, so a slow or silent backend cannot leave a blank window.
// `loadSettings` gives up waiting after a few seconds (the defaults stay) and never rejects.
bindSettingsToRoot(document.documentElement);

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void loadSettings();
void watchOsTransparency();
