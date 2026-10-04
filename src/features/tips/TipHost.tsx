import { useEffect } from 'react';

import { Tip } from './Tip';
import { bindTips } from './runtime';

/** The tool tips (DESIGN 3.47): connects them to the tools and shows the card. Mounted once, with the shell. */
export function TipHost() {
  useEffect(() => bindTips(), []);
  return <Tip />;
}
