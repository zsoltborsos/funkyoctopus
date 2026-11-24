import { describe, expect, it } from 'vitest';
import { AsyncQueue } from './async-queue.ts';

async function drain<T>(q: AsyncQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of q) {
    out.push(v);
  }
  return out;
}

describe('AsyncQueue', () => {
  it('delivers buffered values pushed before consumption, in order', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    await expect(drain(q)).resolves.toEqual([1, 2]);
  });

  it('delivers values pushed after the consumer is waiting', async () => {
    const q = new AsyncQueue<string>();
    const collected = drain(q);
    q.push('a');
    q.push('b');
    q.close();
    await expect(collected).resolves.toEqual(['a', 'b']);
  });

  it('throws the failure after draining buffered values', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.fail(new Error('boom'));
    await expect(drain(q)).rejects.toThrow('boom');
  });

  it('ignores pushes after close', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.close();
    q.push(2);
    await expect(drain(q)).resolves.toEqual([1]);
  });
});
