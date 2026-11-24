import type { ProjectOption } from '../../../src/shared/transport/protocol.ts';
import type { FoClient } from '../cli/fo-client.ts';
import { MethodRegistry } from './registry.ts';

const project: ProjectOption = {
  id: 'fo',
  name: 'FunkyOctopus',
  path: '/work/fo',
  envTier: 'normal',
};

/** Compile-only assertions for sidecar registration and CLI call contracts. */
export function assertSidecarWireContract(registry: MethodRegistry, client: FoClient): void {
  registry.call('projects.resolve', () => project);
  registry.call('projects.resolve', async () => Promise.resolve(project));

  // @ts-expect-error — registrations must use exact WireCalls keys.
  registry.call('projects.resovle', () => project);
  // @ts-expect-error — handler params must match the selected method.
  registry.call('projects.resolve', (_params: { root: null }) => project);
  // @ts-expect-error — synchronous handler results must match the map.
  registry.call('projects.resolve', () => 'not a project');
  // @ts-expect-error — asynchronous handler results must match the map.
  registry.call('projects.resolve', async () => Promise.resolve('not a project'));

  const resolved: Promise<ProjectOption> = client.call(
    'projects.resolve',
    { path: '/work/fo' },
  );
  // @ts-expect-error — CLI method names must be exact WireCalls keys.
  void client.call('projects.resovle', { path: '/work/fo' });
  // @ts-expect-error — CLI params must match the selected method.
  void client.call('projects.resolve', { root: null });

  void resolved;
}
