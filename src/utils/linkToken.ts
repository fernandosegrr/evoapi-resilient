import { createHash, randomBytes, timingSafeEqual } from 'crypto';

// 256 random bits, base64url: 43 characters. The raw token only exists in the admin's create response and in the
// customer's link; the database keeps its SHA-256.
export const LINK_TOKEN_BYTES = 32;
export const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// A consumed link stays readable for a while so the page can show "done" after a reload.
export const CONSUMED_GRACE_MS = 15 * 60 * 1000;

export type LinkTokenState = 'active' | 'expired' | 'revoked' | 'consumed';

export interface LinkTokenTimes {
  expiresAt: Date;
  consumedAt?: Date | null;
  revokedAt?: Date | null;
}

export function generateLinkToken(): string {
  return randomBytes(LINK_TOKEN_BYTES).toString('base64url');
}

export function isWellFormedLinkToken(value: unknown): value is string {
  return typeof value === 'string' && LINK_TOKEN_PATTERN.test(value);
}

export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// The database lookup is by hash, so the comparison below is defence in depth rather than the only barrier.
export function hashesEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length % 2 !== 0) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

// Derived, never stored: revoked > consumed > expired > active.
export function linkTokenState(token: LinkTokenTimes, now: number): LinkTokenState {
  if (token.revokedAt) return 'revoked';
  if (token.consumedAt) return 'consumed';
  if (token.expiresAt.getTime() <= now) return 'expired';
  return 'active';
}

// What the public endpoints may serve: an active link, or a consumed one inside its read-only grace window.
// Revoked, expired and consumed-after-grace links are indistinguishable from an unknown token.
export function isLinkTokenReadable(token: LinkTokenTimes, now: number): boolean {
  const state = linkTokenState(token, now);
  if (state === 'active') return true;
  return state === 'consumed' && !!token.consumedAt && now - token.consumedAt.getTime() <= CONSUMED_GRACE_MS;
}
