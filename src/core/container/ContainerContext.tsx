import { type ReactNode } from 'react';
import type { Container } from './container.ts';
import { ContainerContext } from './container-context.ts';

export function ContainerProvider({
  container,
  children,
}: {
  container: Container;
  children: ReactNode;
}) {
  return <ContainerContext.Provider value={container}>{children}</ContainerContext.Provider>;
}
