/**
 * A single-consumer async queue, which is what makes `MeetingProvider.events`
 * an async iterable rather than a callback registry.
 *
 * The distinction matters: a callback fires whether or not the consumer is
 * ready, so a slow consumer (the gateway, mid agent turn) either drops events
 * or forces the producer to buffer on its behalf. An async iterable lets the
 * consumer pull, and the queue holds the backlog in one place with one bound.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void)[] = [];
  #closed = false;
  readonly #limit: number;

  constructor(limit = 1_000) {
    this.#limit = limit;
  }

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiting.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
      return;
    }
    this.#items.push(item);
    // Drop the oldest rather than grow without bound: a meeting that outruns
    // its consumer by a thousand events has a problem no buffer will fix.
    if (this.#items.length > this.#limit) this.#items.shift();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiting.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  get size(): number {
    return this.#items.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.#items.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.#closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.#waiting.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
