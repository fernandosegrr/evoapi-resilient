export type SerialQueueHooks = {
  /** Called when a task starts, with the time it spent waiting behind the tasks queued before it. */
  onWait?: (waitMs: number) => void;
  now?: () => number;
};

/**
 * Runs tasks strictly one at a time, in the order they were enqueued, and keeps going whatever a task does.
 * It reports how deep the queue is and how long tasks waited so a slow step can be told apart from a backlog.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(private readonly hooks: SerialQueueHooks = {}) {}

  /** Tasks waiting plus the one running. */
  public get depth(): number {
    return this.pending;
  }

  /**
   * The returned promise settles with the task's outcome; the queue itself never stalls on a failure, but the
   * caller must handle the rejection of the promise it gets back.
   */
  public enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const now = this.hooks.now ?? Date.now;
    const enqueuedAt = now();
    this.pending++;

    const run = this.tail.then(async () => {
      try {
        this.hooks.onWait?.(now() - enqueuedAt);
      } catch {
        // observing the queue must never affect it
      }

      try {
        return await task();
      } finally {
        this.pending--;
      }
    });

    this.tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}
