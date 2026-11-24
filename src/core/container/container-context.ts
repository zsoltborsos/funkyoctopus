import { createContext } from 'react';
import type { Container } from './container.ts';

/** The React context carrying the DI container down the tree. */
export const ContainerContext = createContext<Container | null>(null);
