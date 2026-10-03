import { AnimatePresence } from 'motion/react';

import { SignatureSheet } from './SignatureSheet';
import { useSignatureSheet } from './store';

/** Shows the signature creation sheet while a request is open. Mounted once with the shell. */
export function SignatureSheetHost() {
  const request = useSignatureSheet((state) => state.request);
  return (
    <AnimatePresence>
      {request !== null && <SignatureSheet key={request.id} id={request.id} kind={request.kind} />}
    </AnimatePresence>
  );
}
