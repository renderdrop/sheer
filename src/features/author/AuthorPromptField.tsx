import { AnimatePresence } from 'motion/react';
import { UserRound } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { AUTHOR_NAME_MAX, isAuthorName } from '../../api/app';
import { Button, Field } from '../../components';
import { useT } from '../../i18n';
import { useSettings } from '../../stores/settings';
import { DialogShell } from '../save/UnsavedDialog';
import { finishAuthorPrompt, registerAuthorHost, useAuthorPrompt } from './state';

/** Confirm stores the name (when it is valid and not empty) and ends the prompt; Skip, Esc and the backdrop end it with the author left empty. */
function Modal() {
  const t = useT();
  const suggestion = useSettings((state) => state.authorSuggestion);
  const [text, setText] = useState(suggestion);
  const [invalid, setInvalid] = useState(false);
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);

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

  return (
    <DialogShell
      icon={UserRound}
      title={t('author.prompt.label')}
      body={t('author.prompt.hint')}
      onCancel={skip}
      field={
        <div className="mt-4 flex flex-col gap-1">
          <Field
            ref={input}
            data-autofocus=""
            aria-label={t('author.prompt.label')}
            autoComplete="off"
            spellCheck={false}
            maxLength={AUTHOR_NAME_MAX}
            aria-invalid={invalid || undefined}
            aria-errormessage={invalid ? errorId : undefined}
            placeholder={t('author.prompt.placeholder')}
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
            <span id={errorId} role="alert" className="text-sm text-error-text">
              {t('author.prompt.invalid', { max: AUTHOR_NAME_MAX })}
            </span>
          )}
        </div>
      }
    >
      <span className="flex-1" />
      <Button variant="ghost" onClick={skip}>
        {t('author.prompt.skip')}
      </Button>
      <Button variant="primary" onClick={confirm}>
        {t('author.prompt.confirm')}
      </Button>
    </DialogShell>
  );
}

/**
 * The one-time author dialog (ADR-034, ADR-109): a modal shown before the first save of a document with annotations while the
 * author name is empty. Pre-filled with the OS name as a suggestion only. While mounted it is the prompt host: without a host a
 * save does not wait for an answer.
 */
export function AuthorPromptField() {
  const open = useAuthorPrompt((state) => state.open);
  useEffect(() => registerAuthorHost(), []);
  return createPortal(<AnimatePresence>{open && <Modal key="author" />}</AnimatePresence>, document.body);
}
