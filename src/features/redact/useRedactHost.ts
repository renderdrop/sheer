import { useEffect } from 'react';

import { announce } from '../../components';
import { translators } from '../../i18n';
import { useLocaleStore } from '../../i18n/store';
import type { InspectorMode } from '../../lib/layout';
import { selectActiveId, useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';
import { hasTextSelection } from '../textlayer/selection';
import { endRedactMode, markSelection } from './actions';

let savedInspector: InspectorMode | null = null;

/**
 * What the redact mode needs from outside the canvas, installed once by the banner (always mounted in the shell): the mode needs the
 * Select tool (the text is marked by selecting it) and the inspector open, and gives both back; another tool or another document
 * ends it; Esc at tool level ends it; a drag that selects text in a text layer marks that text when the pointer is released, and
 * Enter marks a selection made with the keyboard.
 */
export function useRedactHost(): void {
  useEffect(() => {
    const stopUi = useUi.subscribe((state, previous) => {
      if (state.redactMode && !previous.redactMode) {
        savedInspector = state.inspector;
        useUi.getState().setInspector('open');
        // The text is marked by selecting it, which is the Select tool's.
        useUi.getState().releaseTool();
      } else if (!state.redactMode && previous.redactMode) {
        if (savedInspector !== null) useUi.getState().setInspector(savedInspector);
        savedInspector = null;
      } else if (state.redactMode && state.activeTool !== 'select' && state.activeTool !== previous.activeTool) {
        endRedactMode();
      }
    });
    const stopDocs = useDocuments.subscribe((state, previous) => {
      if (selectActiveId(state) !== selectActiveId(previous) && useUi.getState().redactMode) endRedactMode();
    });

    let fromText = false;
    const inTextLayer = (target: EventTarget | null) =>
      target instanceof Element && target.closest('[data-text-layer]') !== null;
    const onDown = (event: PointerEvent) => {
      fromText = useUi.getState().redactMode && inTextLayer(event.target);
    };
    const onUp = () => {
      if (!fromText) return;
      fromText = false;
      if (useUi.getState().redactMode) markSelection();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!useUi.getState().redactMode || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        endRedactMode();
        announce(translators[useLocaleStore.getState().locale]('redact.exit'));
      } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && inTextLayerSelection()) {
        if (markSelection()) event.preventDefault();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    window.addEventListener('keydown', onKey);
    return () => {
      stopUi();
      stopDocs();
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}

function inTextLayerSelection(): boolean {
  return hasTextSelection(window.getSelection());
}
