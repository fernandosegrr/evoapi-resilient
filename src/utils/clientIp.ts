import { isIP } from 'net';

export interface ClientIpResult {
  ip: string;
  // 'forwarded': taken from X-Forwarded-For; 'socket': the TCP peer (no proxy configured or header unusable).
  source: 'forwarded' | 'socket';
}

function normalise(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let candidate = value.trim();
  if (candidate.toLowerCase().startsWith('::ffff:') && isIP(candidate.slice(7)) === 4) candidate = candidate.slice(7);
  return isIP(candidate) ? candidate : undefined;
}

// The server sits behind exactly `hops` trusted proxies (e.g., Traefik or Nginx). Each of them appends the address
// it saw to X-Forwarded-For, so the real client is the `hops`-th entry from the RIGHT; anything a client prepends
// lives further left and is ignored. If the header does not have that many entries the topology is not what was
// configured and the TCP peer is used instead. Wrong `hops` only degrades per-IP limits; authentication never uses it.
export function resolveClientIp(
  forwardedFor: string | string[] | undefined,
  socketAddress: string | undefined,
  hops: number,
): ClientIpResult {
  const peer = normalise(socketAddress) ?? 'unknown';
  if (!Number.isInteger(hops) || hops <= 0 || forwardedFor === undefined) return { ip: peer, source: 'socket' };

  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length < hops) return { ip: peer, source: 'socket' };

  const candidate = normalise(entries[entries.length - hops]);
  return candidate ? { ip: candidate, source: 'forwarded' } : { ip: peer, source: 'socket' };
}
