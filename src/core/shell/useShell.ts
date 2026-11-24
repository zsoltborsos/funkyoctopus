import { useContext } from 'react';
import { ShellContext } from './shell-context.ts';
import type { ShellState } from './shell.types.ts';

/** Read the shell state from the nearest <ShellProvider>. */
export function useShell(): ShellState {
  const shell = useContext(ShellContext);
  if (!shell) {
    throw new Error('useShell must be used within a <ShellProvider>');
  }
  return shell;
}
