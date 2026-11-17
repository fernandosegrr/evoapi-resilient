import { withDeadline } from '@utils/deadline';

export const DEFAULT_MEDIA_DOWNLOAD_TIMEOUT_MS = 15_000;

export class MediaDownloadTimeoutError extends Error {
  public readonly code = 'MEDIA_DOWNLOAD_TIMEOUT';

  constructor(public readonly timeoutMs: number) {
    super(`Media download did not complete within ${timeoutMs}ms`);
    this.name = 'MediaDownloadTimeoutError';
  }
}

/**
 * Runs a media download under a hard deadline. Whoever awaits it is released with a MediaDownloadTimeoutError
 * (carrying the code that goes into the webhook's `mediaError`) instead of waiting for a stalled proxy.
 * `start` receives the absolute deadline so a retry loop can avoid starting attempts nobody is waiting for.
 */
export function downloadWithinDeadline<T>(start: (deadlineAtMs: number) => Promise<T>, timeoutMs: number): Promise<T> {
  const deadlineAtMs = Date.now() + timeoutMs;

  return withDeadline(
    () => start(deadlineAtMs),
    timeoutMs,
    () => new MediaDownloadTimeoutError(timeoutMs),
  );
}

export function assertBeforeDeadline(deadlineAtMs: number | undefined, timeoutMs = DEFAULT_MEDIA_DOWNLOAD_TIMEOUT_MS) {
  if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) throw new MediaDownloadTimeoutError(timeoutMs);
}
