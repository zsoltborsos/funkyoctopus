/**
 * Bridges a push-based event source (pi's `session.subscribe`) into a pull-based
 * async iterable the transport can stream. Producers `push`/`close`/`fail`;
 * a single consumer drains it with `for await`. Backpressure is unbounded — fine
 * for one agent turn, whose event volume is small and self-limiting.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private pull: ((r: IteratorResult<T>) => void) | null = null;
  private ended = false;
  private failure: Error | null = null;

  push(value: T): void {
    if (this.ended) {
      return;
    }
    if (this.pull) {
      const resolve = this.pull;
      this.pull = null;
      resolve({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  close(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (this.pull) {
      const resolve = this.pull;
      this.pull = null;
      resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.ended) {
      return;
    }
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift() as T;
        continue;
      }
      if (this.ended) {
        if (this.failure) {
          throw this.failure;
        }
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.pull = resolve;
      });
      if (next.done) {
        if (this.failure) {
          throw this.failure;
        }
        return;
      }
      yield next.value;
    }
  }
}
