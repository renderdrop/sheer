/** Uppercase hex pairs joined by ":" ("AB:CD:EF:01"), the form that is copied (DESIGN 3.8 L4). */
export function fingerprintPlain(hex: string): string {
  return (hex.toUpperCase().match(/.{1,2}/g) ?? []).join(':');
}

/** The plain form in blocks of four pairs: `["AB:CD:EF:01", "23:45:67:89", ...]`. */
export function fingerprintBlocks(hex: string): string[] {
  const pairs = hex.toUpperCase().match(/.{1,2}/g) ?? [];
  const blocks: string[] = [];
  for (let i = 0; i < pairs.length; i += 4) blocks.push(pairs.slice(i, i + 4).join(':'));
  return blocks;
}

/** A fingerprint for reading and comparing: monospace, tabular, wrapping only between the blocks (DESIGN 3.8 L4). */
export function Fingerprint({ hex }: { hex: string }) {
  return (
    <span className="min-w-0 flex-1 font-mono text-sm tabular-nums" data-fingerprint="">
      {fingerprintBlocks(hex).map((block, index) => (
        <span key={block + String(index)}>
          {index > 0 && ' '}
          <span className="whitespace-nowrap">{block}</span>
        </span>
      ))}
    </span>
  );
}
