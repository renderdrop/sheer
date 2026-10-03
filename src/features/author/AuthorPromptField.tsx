import { useEffect, useId, useRef, useState } from 'react';

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
  const [invalid, setInvalid] = useState(false);
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  /** Where the focus was when the field opened: it goes back there when the field closes. */
  const returnTo = useRef<Element | null>(null);

  const end = (name: string | null): void => {
    // The save goes on at once; the setting is stored in the background.
    void useSettings.getState().finishAuthorPrompt(name);
    finishAuthorPrompt();
  };
  const confirm = (): void => {
    const name = text.trim();
    if (!isAuthorName(name)) {
      // The field stays and says what is wrong; a silent skip would lose the name the user typed.
      setInvalid(true);
      input.current?.focus({ preventScroll: true });
      return;
    }
    end(name === '' ? null : name);
  };
  const skip = (): void => end(null);

  useEffect(() => {
    returnTo.current = document.activeElement;
    input.current?.focus({ preventScroll: true });
    const unregister = registerDismissLayer(DISMISS_PRIORITY.popover, skip);
    return () => {
      unregister();
      const target = returnTo.current;
      // Back to the previous element, unless the user has moved the focus elsewhere on purpose (or it is gone).
      const active = document.activeElement;
      const lost =
        active === null || active === document.body || active === input.current || !document.contains(active);
      if (lost && target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
    };
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
        aria-invalid={invalid || undefined}
        aria-errormessage={invalid ? errorId : undefined}
        placeholder={t('author.prompt.placeholder')}
        className="w-note min-w-0 flex-auto"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            confirm();
          }
        }}
      />
      {invalid && (
        <span id={errorId} role="alert" className="min-w-0 max-w-note truncate text-sm text-error-text">
          {t('author.prompt.invalid', { max: AUTHOR_NAME_MAX })}
        </span>
      )}
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
