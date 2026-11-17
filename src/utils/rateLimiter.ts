export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  // Hard cap on tracked keys so a flood of spoofed addresses cannot grow memory without bound.
  maxKeys: number;
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

// In-memory sliding window. The backend is a single process that already keeps its WhatsApp runtimes in memory, so
// per-IP limits do not need to be shared; per-link quotas that must survive restarts live in the database instead.
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly options: RateLimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  private prune(key: string, now: number): number[] {
    const kept = (this.hits.get(key) ?? []).filter((at) => now - at < this.options.windowMs);
    if (kept.length > 0) this.hits.set(key, kept);
    else this.hits.delete(key);
    return kept;
  }

  private evictIfFull(key: string) {
    if (this.hits.has(key) || this.hits.size < this.options.maxKeys) return;
    // Map iterates in insertion order: drop the oldest tenth.
    const drop = Math.max(1, Math.floor(this.options.maxKeys / 10));
    let removed = 0;
    for (const existing of this.hits.keys()) {
      this.hits.delete(existing);
      if (++removed >= drop) break;
    }
  }

  // Read-only check.
  peek(key: string): RateLimitResult {
    const now = this.now();
    const kept = this.prune(key, now);
    const allowed = kept.length < this.options.limit;
    return {
      allowed,
      remaining: Math.max(0, this.options.limit - kept.length),
      retryAfterMs: allowed ? 0 : Math.max(1, kept[0] + this.options.windowMs - now),
    };
  }

  // Counts one event if the limit has not been reached.
  hit(key: string): RateLimitResult {
    const now = this.now();
    const kept = this.prune(key, now);
    if (kept.length >= this.options.limit) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, kept[0] + this.options.windowMs - now) };
    }
    this.evictIfFull(key);
    kept.push(now);
    this.hits.set(key, kept);
    return { allowed: true, remaining: this.options.limit - kept.length, retryAfterMs: 0 };
  }

  // Counts one event unconditionally (failures that must accumulate even past the limit).
  record(key: string): void {
    const now = this.now();
    const kept = this.prune(key, now);
    this.evictIfFull(key);
    kept.push(now);
    this.hits.set(key, kept);
  }

  sweep(): void {
    const now = this.now();
    for (const key of [...this.hits.keys()]) this.prune(key, now);
  }

  get size(): number {
    return this.hits.size;
  }
}
