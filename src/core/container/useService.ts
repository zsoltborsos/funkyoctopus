import { useContext } from 'react';
import type { Token } from './container.ts';
import { ContainerContext } from './container-context.ts';

/** Resolve a service from the container provided to the React tree. */
export function useService<T>(t: Token<T>): T {
  const container = useContext(ContainerContext);
  if (!container) {
    throw new Error('useService must be used within a <ContainerProvider>');
  }
  return container.resolve(t);
}
