import { Logger } from '@config/logger.config';
import { AxiosRequestConfig } from 'axios';
import { DEFAULT_CONNECTION_CONFIG, WAVersion } from 'baileys';
import { mkdir, readFile, rename, stat, writeFile } from 'fs/promises';
import path from 'path';
import { Agent, fetch } from 'undici';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 250;
const REMOTE_URL = 'https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/index.ts';
const configuredMaxAge = Number(process.env.WA_VERSION_MAX_AGE_MS);
const MAX_AGE_MS = Number.isSafeInteger(configuredMaxAge) && configuredMaxAge > 0 ? configuredMaxAge : 7 * CACHE_TTL_MS;
const CACHE_PATH = process.env.WA_VERSION_CACHE_PATH || path.join(process.cwd(), 'instances', 'wa-web-version.json');
const logger = new Logger('WaWebVersion');

type StoredVersion = { version: WAVersion; fetchedAt: number; source: 'github' };
type VersionSource = 'remote' | 'memory' | 'persisted' | 'last-good' | 'bundled';
type VersionResult = { version: WAVersion; isLatest: boolean; source: VersionSource; ageMs: number | null };
let lastGood: StoredVersion | undefined;
let loadedFromDisk = false;
let initialLoad: Promise<void> | undefined;
let pendingVersion: Promise<void> | undefined;
let nextAttemptAt = 0;
const telemetry = { refreshSuccess: 0, refreshFailure: 0, persistenceFailure: 0, uses: {} as Record<string, number> };

const validVersion = (value: unknown): value is WAVersion =>
  Array.isArray(value) && value.length === 3 && value.every((part) => Number.isSafeInteger(part) && part > 0);

export function parseWaWebVersion(source: string): WAVersion {
  // Match the named declaration, independent of imports, comments and line placement. Reject ambiguous declarations.
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const matches = [
    ...clean.matchAll(
      /^\s*(?:export\s+)?const\s+version(?:\s*:\s*WAVersion)?\s*=\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,?\s*\]\s*;?\s*$/gm,
    ),
  ];
  const version = matches.length === 1 ? matches[0].slice(1).map(Number) : undefined;
  if (!validVersion(version)) throw new Error('Invalid remote WhatsApp Web version declaration');
  return version;
}

async function bounded<T>(promise: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('WhatsApp Web version operation timed out')), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function usable(value: StoredVersion | undefined): boolean {
  const age = Date.now() - value?.fetchedAt;
  return (
    value?.source === 'github' &&
    validVersion(value.version) &&
    Number.isSafeInteger(value.fetchedAt) &&
    age >= 0 &&
    age <= MAX_AGE_MS
  );
}

async function loadPersisted(): Promise<void> {
  if (!initialLoad)
    initialLoad = bounded(
      (async () => {
        if ((await stat(CACHE_PATH)).size > 4096) throw new Error('Oversized version cache');
        const stored = JSON.parse(await readFile(CACHE_PATH, 'utf8')) as StoredVersion;
        if (!usable(stored)) throw new Error('Invalid or expired version cache');
        return stored;
      })(),
      FILE_TIMEOUT_MS,
    )
      .then((stored) => {
        lastGood = stored;
        loadedFromDisk = true;
      })
      .catch(() => {
        logger.info({ event: 'wa_version.cache_unavailable' });
      });
  await initialLoad;
}

async function requestCurrentVersion(timeout: number): Promise<StoredVersion> {
  const dispatcher = new Agent({ connect: { timeout }, headersTimeout: timeout, bodyTimeout: timeout });
  const controller = new AbortController();
  try {
    const version = await bounded(
      (async () => {
        const response = await fetch(REMOTE_URL, { dispatcher, signal: controller.signal });
        if (!response.ok) throw new Error('WhatsApp Web version HTTP failure');
        if (Number(response.headers.get('content-length')) > 256 * 1024) throw new Error('Oversized version response');
        const source = await response.text();
        if (source.length > 256 * 1024) throw new Error('Oversized version response');
        return parseWaWebVersion(source);
      })(),
      timeout,
    );
    return { version, fetchedAt: Date.now(), source: 'github' };
  } finally {
    controller.abort();
    void dispatcher.destroy().catch(() => {});
  }
}

function refresh(timeout: number): void {
  if (pendingVersion || Date.now() < nextAttemptAt) return;
  nextAttemptAt = Date.now() + 30_000;
  pendingVersion = requestCurrentVersion(timeout)
    .then(async (stored) => {
      // Only a validated remote response becomes last-good. Bundled fallbacks are never persisted or cached as fresh.
      lastGood = stored;
      loadedFromDisk = false;
      telemetry.refreshSuccess++;
      logger.info({ event: 'wa_version.refresh', source: 'remote', ageMs: 0, version: stored.version });
      try {
        await bounded(
          (async () => {
            await mkdir(path.dirname(CACHE_PATH), { recursive: true });
            const temporary = `${CACHE_PATH}.${process.pid}.tmp`;
            await writeFile(temporary, JSON.stringify(stored), { mode: 0o600 });
            await rename(temporary, CACHE_PATH);
          })(),
          FILE_TIMEOUT_MS,
        );
      } catch {
        telemetry.persistenceFailure++;
        logger.warn({ event: 'wa_version.persistence_failed' });
      }
    })
    .catch(() => {
      telemetry.refreshFailure++;
      logger.warn({ event: 'wa_version.refresh_failed', retryAfterMs: 30_000 });
    })
    .finally(() => {
      pendingVersion = undefined;
    });
}

function result(source: VersionSource): VersionResult {
  const selected = source === 'bundled' ? DEFAULT_CONNECTION_CONFIG.version : lastGood.version;
  const ageMs = source === 'bundled' ? null : Date.now() - lastGood.fetchedAt;
  telemetry.uses[source] = (telemetry.uses[source] ?? 0) + 1;
  const value = {
    version: [...selected] as WAVersion,
    isLatest: source === 'remote' || source === 'memory',
    source,
    ageMs,
  };
  logger.info({ event: 'wa_version.selected', ...value });
  return value;
}

export const getWaVersionTelemetry = () => ({ ...telemetry, uses: { ...telemetry.uses } });

export const fetchLatestWaWebVersion = async (
  options: Pick<AxiosRequestConfig, 'timeout'> & { maxWaitMs?: number } = {},
): Promise<VersionResult> => {
  await loadPersisted();
  if (usable(lastGood) && Date.now() - lastGood.fetchedAt < CACHE_TTL_MS) {
    return result(loadedFromDisk ? 'persisted' : 'memory');
  }
  const timeout =
    Number.isFinite(options.timeout) && options.timeout > 0
      ? Math.min(options.timeout, REQUEST_TIMEOUT_MS)
      : REQUEST_TIMEOUT_MS;
  refresh(timeout);
  if (usable(lastGood)) return result('last-good');
  // Cold start has a small, bounded wait budget. The shared refresh continues in the background after fallback.
  const wait = Number.isFinite(options.maxWaitMs) && options.maxWaitMs >= 0 ? Math.min(options.maxWaitMs, 250) : 250;
  if (wait && pendingVersion) await bounded(pendingVersion, wait).catch(() => {});
  if (usable(lastGood)) return result('remote');
  return result('bundled');
};
