/**
 * Commit, cancel and retry of the open line edit (DESIGN 3.10 E1, E6). Seam of v1.5.1 wave 2: the bodies belong to the edit layer
 * package (P1); the mini bar (P2) only calls them.
 */
export async function commitEdit(): Promise<void> {
  // P1: send `editTextLine` through `applyCommand`, set status busy → close or error.
}

export function cancelEdit(): void {
  // P1: restore the original line and close the box.
}

export async function retryEdit(): Promise<void> {
  // P1: send the same draft again after an error.
}
