import { createContext } from 'react';
import type { ShellState } from './shell.types.ts';

/** Holds the live shell state; consumed via `useShell`. */
export const ShellContext = createContext<ShellState | null>(null);
