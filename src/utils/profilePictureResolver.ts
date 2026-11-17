import { withDeadline } from '@utils/deadline';

export const PROFILE_PICTURE_TIMEOUT_MS = 5_000;
export const PROFILE_PICTURE_MAX_CONCURRENT = 2;
export const PROFILE_PICTURE_MAX_QUEUED = 200;
export const PROFILE_PICTURE_MAX_ENTRIES = 3_000;
export const PROFILE_PICTURE_PHOTO_TTL_MS = 24 * 60 * 60 * 1000;
// WhatsApp answered but the contact has no (visible) photo: privacy settings rarely change.
export const PROFILE_PICTURE_NO_PHOTO_TTL_MS = 6 * 60 * 60 * 1000;
// The query timed out or failed: back off so a bad connection is not hammered once per message.
export const PROFILE_PICTURE_FAILURE_TTL_MS = 60 * 60 * 1000;

export class ProfilePictureTimeoutError extends Error {
  public readonly code = 'PROFILE_PICTURE_TIMEOUT';

  constructor(
    public readonly jid: string,
    public readonly timeoutMs: number,
  ) {
    super(`Profile picture query did not complete within ${timeoutMs}ms`);
    this.name = 'ProfilePictureTimeoutError';
  }
}

export type ProfilePictureLookup = { state: 'photo'; url: string } | { state: 'none' } | { state: 'unknown' };

export type ProfilePictureResolverOptions = {
  /**
   * Resolves the picture URL, `null` when WhatsApp answered that there is no (visible) photo, and rejects
   * on timeouts or transport errors.
   */
  fetchUrl: (jid: string, timeoutMs: number) => Promise<string | null | undefined>;
  /** Called once per newly resolved photo URL. A failure here never affects the cache. */
  onResolved?: (jid: string, url: string) => void | Promise<void>;
  onError?: (jid: string, error: unknown) => void;
  /** Errors that say nothing about the contact (e.g. the connection dropped) are not cached as failures. */
  isTransient?: (error: unknown) => boolean;
  timeoutMs?: number;
  maxConcurrent?: number;
  maxQueued?: number;
  maxEntries?: number;
  photoTtlMs?: number;
  noPhotoTtlMs?: number;
  failureTtlMs?: number;
  now?: () => number;
};

type CacheEntry = { url: string | null; expiresAt: number };

/** Only 1:1 chats and groups have a picture worth asking WhatsApp for (not status, broadcast lists, channels). */
export function isProfilePictureJid(jid?: string | null): boolean {
  return !!jid && /@(s\.whatsapp\.net|lid|hosted|hosted\.lid|g\.us)$/.test(jid);
}

/** Drops an empty photo from a write so a failed lookup can never overwrite a photo that already exists. */
export function omitEmptyPhoto<T extends { profilePicUrl?: string | null }>(contact: T): T {
  if (contact.profilePicUrl) return contact;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { profilePicUrl, ...rest } = contact;
  return rest as T;
}

/**
 * Looks profile pictures up in the background: callers get an immediate answer from the cache and never
 * wait for WhatsApp. Lookups are bounded in time and concurrency, deduplicated per JID, and both
 * successes and failures are cached so a contact is not queried again on every message.
 */
export class ProfilePictureResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Set<string>();
  private queue: string[] = [];
  private active = 0;
  private generation = 0;

  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly maxEntries: number;
  private readonly photoTtlMs: number;
  private readonly noPhotoTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ProfilePictureResolverOptions) {
    this.timeoutMs = options.timeoutMs ?? PROFILE_PICTURE_TIMEOUT_MS;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? PROFILE_PICTURE_MAX_CONCURRENT);
    this.maxQueued = options.maxQueued ?? PROFILE_PICTURE_MAX_QUEUED;
    this.maxEntries = options.maxEntries ?? PROFILE_PICTURE_MAX_ENTRIES;
    this.photoTtlMs = options.photoTtlMs ?? PROFILE_PICTURE_PHOTO_TTL_MS;
    this.noPhotoTtlMs = options.noPhotoTtlMs ?? PROFILE_PICTURE_NO_PHOTO_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? PROFILE_PICTURE_FAILURE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Synchronous and free: never touches the network. */
  public lookup(jid: string): ProfilePictureLookup {
    const entry = this.cache.get(jid);
    if (!entry) return { state: 'unknown' };

    if (entry.expiresAt <= this.now()) {
      this.cache.delete(jid);
      return { state: 'unknown' };
    }

    return entry.url ? { state: 'photo', url: entry.url } : { state: 'none' };
  }

  /** Schedules a background lookup when nothing is known (or cached) for the JID. Returns whether it was queued. */
  public request(jid: string): boolean {
    if (!isProfilePictureJid(jid)) return false;
    if (this.lookup(jid).state !== 'unknown') return false;
    if (this.pending.has(jid)) return false;
    if (this.queue.length >= this.maxQueued) return false;

    this.pending.add(jid);
    this.queue.push(jid);
    this.pump();
    return true;
  }

  /** Forget what is cached for a JID (e.g. WhatsApp told us the picture changed). */
  public invalidate(jid: string) {
    this.cache.delete(jid);
  }

  /** Drops queued work and the cache; results of lookups already in flight are ignored. */
  public clear() {
    this.generation++;
    this.queue = [];
    this.pending.clear();
    this.cache.clear();
  }

  public stats() {
    return { active: this.active, queued: this.queue.length, cached: this.cache.size };
  }

  private pump() {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const jid = this.queue.shift() as string;
      const generation = this.generation;
      this.active++;

      void this.run(jid, generation).finally(() => {
        this.active--;
        if (generation === this.generation) this.pending.delete(jid);
        this.pump();
      });
    }
  }

  private async run(jid: string, generation: number) {
    let url: string | null | undefined;

    try {
      // The deadline is enforced here as well as inside fetchUrl so a lookup that never answers can neither
      // hold one of the concurrency slots nor leave the JID stuck as pending.
      url = await withDeadline(
        () => this.options.fetchUrl(jid, this.timeoutMs),
        this.timeoutMs + 250,
        () => new ProfilePictureTimeoutError(jid, this.timeoutMs),
      );
    } catch (error) {
      if (generation !== this.generation) return;
      if (!this.options.isTransient?.(error)) this.store(jid, null, this.failureTtlMs);
      this.report(jid, error);
      return;
    }

    if (generation !== this.generation) return;

    if (!url) {
      this.store(jid, null, this.noPhotoTtlMs);
      return;
    }

    this.store(jid, url, this.photoTtlMs);

    try {
      await this.options.onResolved?.(jid, url);
    } catch (error) {
      this.report(jid, error);
    }
  }

  private store(jid: string, url: string | null, ttlMs: number) {
    this.cache.delete(jid);
    this.cache.set(jid, { url, expiresAt: this.now() + ttlMs });

    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private report(jid: string, error: unknown) {
    try {
      this.options.onError?.(jid, error);
    } catch {
      // reporting must never break the lookup loop
    }
  }
}
