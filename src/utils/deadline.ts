export class DeadlineError extends Error {
  public readonly code = 'DEADLINE_EXCEEDED';

  constructor(
    public readonly label: string,
    public readonly timeoutMs: number,
  ) {
    super(`${label} did not complete within ${timeoutMs}ms`);
    this.name = 'DeadlineError';
  }
}

/**
 * Settles with `work`, or rejects once `timeoutMs` elapses, whichever happens first.
 *
 * The underlying work cannot be cancelled from here, so whatever it produces after the deadline
 * is discarded; a late rejection is swallowed rather than surfacing as an unhandled rejection.
 */
export function withDeadline<T>(
  work: Promise<T> | (() => Promise<T>),
  timeoutMs: number,
  onTimeout: () => Error = () => new DeadlineError('operation', timeoutMs),
): Promise<T> {
  let started: Promise<T>;
  try {
    started = typeof work === 'function' ? Promise.resolve(work()) : work;
  } catch (error) {
    return Promise.reject(error);
  }

  started.catch(() => undefined);

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), timeoutMs);

    started.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
