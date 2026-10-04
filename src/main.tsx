import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { watchNativeMenu } from './actions/menuBridge';
import { App } from './App';
import { APP_NAME } from './config/app';
import { watchAppEvents } from './features/viewer/appEvents';
import { bindLocaleToSettings } from './i18n/bind';
import { loadSettings } from './stores/settings';
import { bindPanelWidthToSettings } from './stores/ui';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/type.css';

document.title = APP_NAME;

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element');
}

// The window never waits for the backend: it renders at once with the defaults and the
// saved settings are applied when they arrive, so a slow or silent backend cannot leave a blank window.
// `loadSettings` gives up waiting after a few seconds (the defaults stay) and never rejects.
// The language follows the OS until the saved one arrives; it sets the UI's locale and `<html lang>`.
bindLocaleToSettings(document.documentElement);
// The left panel's width follows the saved one once the settings have loaded, and is saved when the user changes it.
bindPanelWidthToSettings();

createRoot(container).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
);

void loadSettings();
// The macOS menu bar's commands arrive over a channel (nothing arrives on Windows, which has no menu bar).
void watchNativeMenu();
// Files dropped on the window, opened by the OS or given at startup arrive over a channel too (and the drop overlay follows
// the drag), so the window never hears a path.
void watchAppEvents();
