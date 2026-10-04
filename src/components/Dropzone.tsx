import { useRef, useState, type DragEvent, type ReactNode } from 'react';

import { cx } from './cx';

export interface DropzoneProps {
  children: ReactNode;
  /** Called with the dropped files. The caller decides what to accept. */
  onDropFiles?: (files: File[]) => void;
  className?: string;
}

/**
 * A drop target (DESIGN 4): 1 px dashed #E5E5E1, radius lg, Sand. While a drag is over it the border turns Stone. The text inside
 * is the cue; colour only confirms it. It does not read files itself.
 */
export function Dropzone({ children, onDropFiles, className }: DropzoneProps) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  const enter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    depth.current += 1;
    setOver(true);
  };
  const leave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  };

  return (
    <div
      data-dragover={over ? '' : undefined}
      onDragEnter={enter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={leave}
      onDrop={(event) => {
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        onDropFiles?.(Array.from(event.dataTransfer.files));
      }}
      className={cx(
        'rounded-lg border border-dashed bg-subtle transition-[border-color] duration-fast',
        over ? 'border-control-border' : 'border-divider',
        className,
      )}
    >
      {children}
    </div>
  );
}
