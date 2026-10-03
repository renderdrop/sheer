import { useEffect, useRef, useState } from 'react';

import { AUTHOR_NAME_MAX, isAuthorName } from '../../api/app';
import { Button, Field } from '../../components';
import { DISMISS_PRIORITY, registerDismissLayer } from '../../components/dismiss';
import { useT } from '../../i18n';
import { useSettings } from '../../stores/settings';
import { finishAuthorPrompt, useAuthorPrompt } from './state';

/** Confirm stores the name (when it is valid and not empty) and ends the prompt; Skip and Esc end it with the author left empty. */
function Inline() {
  const t = useT();
  const suggestion = useSettings((state) => state.authorSuggestion);
  const [text, setText] = useState(suggestion);
  const input = useRef<HTMLInputElement>(null);

  const end = (name: string | null): void => {
    // The save goes on at once; the setting is stored in the background.
    void useSettings.getState().finishAuthorPrompt(name);
    finishAuthorPrompt();
  };
  const confirm = (): void => {
    const name = text.trim();
    end(isAuthorName(name) ? name : null);
  };
  const skip = (): void => end(null);

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    return registerDismissLayer(DISMISS_PRIORITY.popover, skip);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registered once for this showing; `skip` only reads the store
  }, []);

  return (
    <div
      role="group"
      aria-label={t('author.prompt.label')}
      className="glass-1 ms-1 flex h-control-lg min-w-0 shrink items-center gap-1 rounded-panel p-0-5 ps-1"
    >
      <Field
        ref={input}
        size="sm"
        aria-label={t('author.prompt.label')}
        aria-description={t('author.prompt.hint')}
        autoComplete="off"
        spellCheck={false}
        maxLength={AUTHOR_NAME_MAX}
        placeholder={t('settings.author.placeholder')}
        className="w-note min-w-0 flex-auto"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            confirm();
          }
        }}
      />
      <Button variant="primary" size="sm" onClick={confirm}>
        {t('author.prompt.confirm')}
      </Button>
      <Button variant="ghost" size="sm" onClick={skip}>
        {t('author.prompt.skip')}
      </Button>
    </div>
  );
}

/**
 * The one-time author field in its own slot of the toolbar row (ADR-034, DESIGN 3.13): shown before the first save of a document
 * with annotations while the author name is empty. Pre-filled with the OS name as a suggestion only.
 */
export function AuthorPromptField() {
  const open = useAuthorPrompt((state) => state.open);
  return open ? <Inline /> : null;
}
