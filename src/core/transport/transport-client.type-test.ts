import type { ProjectOption } from '@shared/transport/protocol.ts';
import type { TransportClient } from './transport-client.ts';

/** Compile-only assertions for the browser's public typed call surface. */
export function assertTransportCallContract(client: TransportClient): void {
  const resolved: Promise<ProjectOption> = client.call('projects.resolve', { path: '/work/fo' });
  const omittedNoParams = client.call('projects.discover');
  const emptyNoParams = client.call('projects.discover', {});

  // @ts-expect-error — method names must be exact WireCalls keys.
  void client.call('projects.resovle', { path: '/work/fo' });
  // @ts-expect-error — projects.resolve requires a path.
  void client.call('projects.resolve', { root: null });
  // @ts-expect-error — projects.resolve does not permit omitted params.
  void client.call('projects.resolve');

  void resolved;
  void omittedNoParams;
  void emptyNoParams;

  // Streams are typed too: a chat stream must name its slot.
  void client.stream('chat.observe', { chatId: 'main' }, { onChunk: () => undefined, onEnd: () => undefined });
  // @ts-expect-error — chat.observe requires a chatId.
  void client.stream('chat.observe', {}, { onChunk: () => undefined, onEnd: () => undefined });
  // @ts-expect-error — stream names must be exact WireStreams keys.
  void client.stream('chat.obsrve', { chatId: 'main' }, { onChunk: () => undefined, onEnd: () => undefined });
  // @ts-expect-error — chat.current requires a chatId.
  void client.call('chat.current', {});
}
