import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { APP_NAME } from './config/app';
import { bindLocaleToSettings } from './i18n/bind';
import { bindSettingsToRoot, loadSettings, watchOsTransparency } from './stores/settings';
import { bindPanelWidthToSettings } from './stores/ui';
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
// The language follows the OS until the saved one arrives; it sets the UI's locale and `<html lang>`.
bindLocaleToSettings(document.documentElement);
// The left panel's width follows the saved one once the settings have loaded, and is saved when the user changes it.
bindPanelWidthToSettings();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void loadSettings();
void watchOsTransparency();
