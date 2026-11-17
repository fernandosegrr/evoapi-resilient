import type { PrismaRepository } from '@api/repository/repository.service';
import type { LineSnapshot, ResetCredentialsMode, WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import type { ConfigService, Database, Link } from '@config/env.config';
import { Logger } from '@config/logger.config';
import {
  canonicalNumber,
  equivalentNumbers,
  jidToDigits,
  lastFour,
  maskNumber,
  parseLinkPhone,
  toPairingNumber,
} from '@utils/linkPhone';
import {
  generateLinkToken,
  hashesEqual,
  hashLinkToken,
  isLinkTokenReadable,
  isWellFormedLinkToken,
  linkTokenState,
} from '@utils/linkToken';

// Baileys renews the QR (and therefore the pairing code) on the SAME socket every qrTimeout = 45s.
const QR_RENEWAL_MS = 45_000;
const HOUR_MS = 3_600_000;
const MAX_ACTIVE_LINKS_PER_INSTANCE = 5;
const ENDED_MEMORY_MS = 15 * 60 * 1000;
const ENDED_MEMORY_MAX = 500;
const FORGET_FINALIZING_MS = 5 * 60 * 1000;
const RESET_RETRY_MS = 5_000;

export type LinkErrorCode =
  | 'invalid_link'
  | 'invalid_number'
  | 'bad_request'
  | 'not_found'
  | 'too_many_links'
  | 'already_linked'
  | 'has_session'
  | 'reconnecting'
  | 'unavailable'
  | 'attempt_in_progress'
  | 'resets_exhausted'
  | 'attempts_exhausted'
  | 'rate_limited';

export const LINK_ERROR_STATUS: Record<LinkErrorCode, number> = {
  invalid_link: 401,
  invalid_number: 400,
  bad_request: 400,
  not_found: 404,
  too_many_links: 409,
  already_linked: 409,
  has_session: 409,
  reconnecting: 409,
  unavailable: 409,
  attempt_in_progress: 409,
  resets_exhausted: 409,
  attempts_exhausted: 409,
  rate_limited: 429,
};

export class LinkError extends Error {
  constructor(
    readonly code: LinkErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LinkError';
  }

  get status() {
    return LINK_ERROR_STATUS[this.code];
  }
}

// Customer-facing messages are generic on purpose: they never name the instance, a number or an internal cause.
const MESSAGES: Record<LinkErrorCode, string> = {
  invalid_link: 'Enlace inválido o vencido.',
  invalid_number: 'Revisa el número de WhatsApp, con código de país.',
  bad_request: 'La solicitud no es válida.',
  not_found: 'No se encontró.',
  too_many_links: 'Esta línea ya tiene demasiados enlaces activos.',
  already_linked: 'Esta línea ya está vinculada.',
  has_session: 'Esta línea ya tiene una sesión guardada. Pide a tu asesor un enlace de restablecimiento.',
  reconnecting: 'La línea se está reconectando. Intenta de nuevo en unos minutos.',
  unavailable: 'No pudimos iniciar la vinculación ahora. Contacta a tu asesor.',
  attempt_in_progress: 'Ya hay una vinculación en curso para esta línea.',
  resets_exhausted: 'No pudimos completar la vinculación. Pide un enlace nuevo a tu asesor.',
  attempts_exhausted: 'Este enlace ya no admite más intentos. Pide un enlace nuevo a tu asesor.',
  rate_limited: 'Demasiados intentos. Espera un momento antes de volver a intentarlo.',
};

// Thrown inside the start guard when an identical attempt is already running: the request gets that attempt back,
// with no new socket and no quota. The check lives in the critical section so that simultaneous taps cannot both pass.
class ReuseAttempt extends Error {
  constructor(readonly attempt: unknown) {
    super('reuse');
  }
}

const fail = (code: LinkErrorCode, retryAfterMs?: number): never => {
  throw new LinkError(code, MESSAGES[code], retryAfterMs);
};

export type Blocked =
  | 'already_linked'
  | 'has_session'
  | 'reconnecting'
  | 'unavailable'
  | 'attempt_in_progress'
  | 'resets_exhausted'
  | 'attempts_exhausted';

export type PublicLineState = 'close' | 'connecting' | 'finalizing' | 'open';
export type EndReason = 'expired' | 'exhausted' | 'rate_limited' | 'revoked' | 'failed' | 'replaced';
type LinkMode = 'code' | 'qr';
// Without strictNullChecks a discriminated union on `ok` does not narrow, so this is a plain shape.
type Quota = { ok: boolean; reason?: 'hourly' | 'lifetime' | 'resets'; retryAfterMs?: number };

export interface PublicAttempt {
  mode: LinkMode;
  expiresInMs: number;
  resets: number;
  resetsLeft: number;
}

export interface PublicStatus {
  link: {
    state: 'active' | 'consumed';
    expiresInMs: number;
    displayName: string | null;
    attemptsLeft: number;
    numberHint: string | null;
  };
  line: { state: PublicLineState; canStart: boolean; blocked: Blocked | null };
  attempt: PublicAttempt | null;
}

export interface PublicCode {
  state: 'idle' | 'waiting' | 'ready' | 'finalizing' | 'linked' | 'failed' | 'exhausted';
  pairingCode?: string;
  qr?: string;
  expiresInMs?: number;
  resetInMs: number | null;
  resets: number;
  resetsLeft: number;
  reason?: EndReason;
}

interface Attempt {
  instanceName: string;
  tokenId: string;
  mode: LinkMode;
  number?: string;
  startedAt: number;
  expiresAt: number;
  // Bumped by every reset: a timer armed for an older socket can never act on a newer one.
  generation: number;
  runtime: unknown;
  // When the code/QR of the current socket was first served to the person; the reset clock starts here.
  shownAt: number | null;
  codeKey?: number;
  codeSeenAt?: number;
  finalizing: boolean;
  ended?: EndReason;
  ttlTimer?: NodeJS.Timeout;
  resetTimer?: NodeJS.Timeout;
  forgetTimer?: NodeJS.Timeout;
}

type LinkRow = {
  id: string;
  instanceId: string;
  tokenHash: string;
  displayName: string | null;
  allowReset: boolean;
  expectedNumber: string | null;
  expiresAt: Date;
  createdAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  attemptCount: number;
  autoResets: number;
  windowStartedAt: Date | null;
  windowAttempts: number;
  lastAttemptAt: Date | null;
};

type AuthedLink = LinkRow & { Instance: { name: string; clientName: string | null; integration: string | null } };

interface Inspection {
  name: string;
  snap: LineSnapshot | null;
  state: PublicLineState;
  paired: boolean;
  blocked: Blocked | null;
  // The link is allowed to replace a stored, paired session on a closed line.
  resetPaired: boolean;
}

export interface CreateLinkInput {
  instanceName: string;
  ttlHours?: number;
  displayName?: string;
  allowReset?: boolean;
  expectedNumber?: string;
}

// What the reset is allowed to see of the world; kept narrow so the decision logic is easy to test.
function ownerDigitsOf(runtime: any): string {
  return (
    jidToDigits(runtime?.client?.user?.id) ||
    jidToDigits(runtime?.instance?.authState?.state?.creds?.me?.id) ||
    jidToDigits(runtime?.instance?.wuid)
  );
}

export class LinkService {
  private readonly logger = new Logger('LinkService');
  private readonly attempts = new Map<string, Attempt>();
  private readonly ended = new Map<string, { reason: EndReason; at: number }>();
  private readonly opening = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaRepository,
    private readonly monitor: WAMonitoringService,
    private readonly configService: ConfigService,
    private readonly clock: () => number = Date.now,
  ) {
    this.monitor.onInstanceOpen((name, runtime) => this.handleOpen(name, runtime));
  }

  private get config(): Link {
    return this.configService.get<Link>('LINK');
  }

  private get clientName(): string {
    return this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;
  }

  // ------------------------------------------------------------------------------------------------ admin

  public async createLink(input: CreateLinkInput) {
    const cfg = this.config;
    const name = typeof input.instanceName === 'string' ? input.instanceName.trim() : '';
    if (!name) throw new LinkError('bad_request', 'instanceName is required');

    const instance = await this.prisma.instance.findFirst({
      where: { name, clientName: this.clientName },
      select: { id: true, integration: true, connectionStatus: true },
    });
    if (!instance) throw new LinkError('not_found', `The "${name}" instance does not exist`);
    if (instance.integration !== Integration.WHATSAPP_BAILEYS) {
      throw new LinkError('bad_request', 'Links are only available for WHATSAPP-BAILEYS instances');
    }
    const snap = this.monitor.getLineSnapshot(name);
    if (snap?.state === 'open' || (!snap && instance.connectionStatus === 'open')) {
      throw new LinkError('already_linked', 'The line is already linked: a link would have no purpose');
    }

    let ttlHours = cfg.TOKEN_DEFAULT_TTL_HOURS;
    if (input.ttlHours !== undefined) {
      if (typeof input.ttlHours !== 'number' || !Number.isFinite(input.ttlHours) || input.ttlHours <= 0) {
        throw new LinkError('bad_request', 'ttlHours must be a positive number');
      }
      if (input.ttlHours > cfg.TOKEN_MAX_TTL_HOURS) {
        throw new LinkError('bad_request', `ttlHours cannot exceed ${cfg.TOKEN_MAX_TTL_HOURS}`);
      }
      ttlHours = input.ttlHours;
    }

    let displayName: string | null = null;
    if (input.displayName !== undefined && input.displayName !== null) {
      // eslint-disable-next-line no-control-regex
      if (typeof input.displayName !== 'string' || /[\u0000-\u001f\u007f]/.test(input.displayName)) {
        throw new LinkError('bad_request', 'displayName must be plain text');
      }
      displayName = input.displayName.trim() || null;
      if (displayName && displayName.length > 100) throw new LinkError('bad_request', 'displayName is too long');
    }

    if (input.allowReset !== undefined && typeof input.allowReset !== 'boolean') {
      throw new LinkError('bad_request', 'allowReset must be a boolean');
    }

    let expectedNumber: string | null = null;
    if (input.expectedNumber !== undefined && input.expectedNumber !== null && input.expectedNumber !== '') {
      const parsed = parseLinkPhone(input.expectedNumber);
      if (!parsed.ok) throw new LinkError('bad_request', 'expectedNumber is not a valid phone number');
      expectedNumber = canonicalNumber(parsed.digits);
    }

    const now = this.clock();
    const active = await this.prisma.linkToken.count({
      where: { instanceId: instance.id, consumedAt: null, revokedAt: null, expiresAt: { gt: new Date(now) } },
    });
    if (active >= MAX_ACTIVE_LINKS_PER_INSTANCE) fail('too_many_links');

    const token = generateLinkToken();
    const row = await this.prisma.linkToken.create({
      data: {
        instanceId: instance.id,
        tokenHash: hashLinkToken(token),
        displayName,
        allowReset: input.allowReset === true,
        expectedNumber,
        expiresAt: new Date(now + ttlHours * HOUR_MS),
      },
    });

    this.logger.info({
      evento: 'creado',
      enlace: row.id,
      instancia: name,
      allowReset: row.allowReset,
      ttlHoras: ttlHours,
    });
    const path = `/manager/link#t=${token}`;
    return {
      ...this.summarize(row as LinkRow, now),
      // The only time the raw token exists outside the customer's link.
      token,
      path,
      url: cfg.PUBLIC_BASE_URL ? `${cfg.PUBLIC_BASE_URL}${path}` : undefined,
    };
  }

  public async listLinks(instanceName: string) {
    const name = typeof instanceName === 'string' ? instanceName.trim() : '';
    if (!name) throw new LinkError('bad_request', 'instanceName is required');
    const instance = await this.prisma.instance.findFirst({
      where: { name, clientName: this.clientName },
      select: { id: true },
    });
    if (!instance) throw new LinkError('not_found', `The "${name}" instance does not exist`);

    const rows = await this.prisma.linkToken.findMany({
      where: { instanceId: instance.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const now = this.clock();
    return rows.map((row) => this.summarize(row as LinkRow, now));
  }

  public async revokeLink(linkId: string) {
    if (typeof linkId !== 'string' || !linkId || linkId.length > 100)
      throw new LinkError('not_found', 'Link not found');
    const row = await this.prisma.linkToken.findUnique({
      where: { id: linkId },
      include: { Instance: { select: { name: true, clientName: true } } },
    });
    if (!row || (row as any).Instance?.clientName !== this.clientName)
      throw new LinkError('not_found', 'Link not found');

    const now = this.clock();
    await this.prisma.linkToken.updateMany({
      where: { id: linkId, revokedAt: null },
      data: { revokedAt: new Date(now) },
    });

    const name = (row as any).Instance.name as string;
    const attempt = this.attempts.get(name);
    if (attempt && attempt.tokenId === linkId) await this.endAttempt(attempt, 'revoked');

    this.logger.info({ evento: 'revocado', enlace: linkId, instancia: name });
    const fresh = await this.prisma.linkToken.findUnique({ where: { id: linkId } });
    return this.summarize((fresh ?? row) as LinkRow, now);
  }

  public describeSessionStore(): 'database' | 'redis' | 'provider' | 'none' {
    if (!this.monitor.usesDatabaseSessions()) {
      const cache = this.configService.get<any>('CACHE');
      const provider = this.configService.get<any>('PROVIDER');
      if (provider?.ENABLED) return 'provider';
      if (cache?.REDIS?.ENABLED && cache?.REDIS?.SAVE_INSTANCES) return 'redis';
      return 'none';
    }
    return 'database';
  }

  private summarize(row: LinkRow, now: number) {
    return {
      id: row.id,
      displayName: row.displayName,
      state: linkTokenState(row, now),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
      revokedAt: row.revokedAt,
      attemptCount: row.attemptCount,
      autoResets: row.autoResets,
      lastAttemptAt: row.lastAttemptAt,
      allowReset: row.allowReset,
      expectedNumber: row.expectedNumber ? maskNumber(row.expectedNumber) : null,
    };
  }

  // ------------------------------------------------------------------------------------------------ public

  private async authenticate(token: unknown): Promise<AuthedLink> {
    if (!isWellFormedLinkToken(token)) return fail('invalid_link');
    const hash = hashLinkToken(token);
    const row = (await this.prisma.linkToken.findUnique({
      where: { tokenHash: hash },
      include: { Instance: { select: { name: true, clientName: true, integration: true } } },
    })) as AuthedLink | null;
    if (!row || !hashesEqual(row.tokenHash, hash)) return fail('invalid_link');
    if (!isLinkTokenReadable(row, this.clock()) || row.Instance?.clientName !== this.clientName)
      return fail('invalid_link');
    return row;
  }

  private attemptsLeft(link: LinkRow, now: number): number {
    const cfg = this.config;
    const inWindow = link.windowStartedAt && now - link.windowStartedAt.getTime() < HOUR_MS;
    const hourly = cfg.ATTEMPTS_PER_HOUR - (inWindow ? link.windowAttempts : 0);
    return Math.max(0, Math.min(hourly, cfg.ATTEMPTS_PER_TOKEN - link.attemptCount));
  }

  private resetsLeft(link: LinkRow): number {
    const cfg = this.config;
    return cfg.MAX_AUTO_RESETS > 0 ? Math.max(0, cfg.MAX_AUTO_RESETS - link.autoResets) : 0;
  }

  // Decides what the line allows right now. Used for the read-only status and, again, inside the critical section of
  // start/reset, where nothing can change between the check and the action.
  private async inspectLine(link: AuthedLink): Promise<Inspection> {
    const cfg = this.config;
    const name = link.Instance.name;
    const snap = this.monitor.getLineSnapshot(name);
    const own = this.attempts.get(name)?.tokenId === link.id ? this.attempts.get(name) : undefined;
    const base = { name, snap, paired: false, resetPaired: false };

    if (!snap || snap.integration !== Integration.WHATSAPP_BAILEYS || !this.monitor.usesDatabaseSessions()) {
      return { ...base, state: 'close', blocked: 'unavailable' };
    }
    if (snap.state === 'open') return { ...base, state: 'open', blocked: 'already_linked' };

    const paired = await this.monitor.isSessionPaired(name);
    // The phone has started to link: the code was accepted (registered) or pair-success arrived (account). Right after
    // that Baileys restarts the socket, but by then the stored session is paired, so "paired" is the only signal.
    if (own && !own.ended && paired) return { ...base, paired, state: 'finalizing', blocked: null };
    // A socket of ours being replaced WITHOUT a paired session (a reset, a retry) is NOT the phone linking: treating it
    // as such cancelled the following resets (found in the live validation).
    if (own && !own.ended && snap.reconnecting) return { ...base, paired, state: 'connecting', blocked: null };

    const state: PublicLineState = snap.state === 'connecting' ? 'connecting' : 'close';
    const otherAttempt = this.attempts.get(name);
    let blocked: Blocked | null = null;
    let resetPaired = false;

    if (snap.reconnecting) blocked = 'reconnecting';
    else if (paired) {
      if (snap.state === 'close' && link.allowReset) resetPaired = true;
      else blocked = snap.state === 'close' ? 'has_session' : 'reconnecting';
    } else if (snap.state === 'close' && (await this.proxyUnavailable(name, snap))) blocked = 'unavailable';

    if (!blocked && otherAttempt && otherAttempt.tokenId !== link.id && !otherAttempt.ended)
      blocked = 'attempt_in_progress';
    if (!blocked && !own) {
      if (cfg.MAX_AUTO_RESETS > 0 && link.autoResets >= cfg.MAX_AUTO_RESETS) blocked = 'resets_exhausted';
      else if (link.attemptCount >= cfg.ATTEMPTS_PER_TOKEN) blocked = 'attempts_exhausted';
    }
    return { ...base, paired, state, blocked, resetPaired };
  }

  // After a restart the in-memory reason is gone; the database still knows why the line was given up.
  private async proxyUnavailable(name: string, snap: LineSnapshot): Promise<boolean> {
    if (snap.requiresManualIntervention) return snap.reason === 'proxy_unavailable';
    try {
      const row = await this.prisma.instance.findFirst({
        where: { name, clientName: this.clientName },
        select: { disconnectionObject: true },
      });
      let value: any = row?.disconnectionObject;
      if (typeof value === 'string') value = JSON.parse(value);
      return value?.requiresManualIntervention === true && value?.reason === 'proxy_unavailable';
    } catch {
      return false;
    }
  }

  public async status(token: unknown): Promise<PublicStatus> {
    const link = await this.authenticate(token);
    const now = this.clock();
    const expiresInMs = Math.max(0, link.expiresAt.getTime() - now);
    const numberHint = link.expectedNumber ? maskNumber(link.expectedNumber) : null;

    if (linkTokenState(link, now) === 'consumed') {
      return {
        link: { state: 'consumed', expiresInMs, displayName: link.displayName, attemptsLeft: 0, numberHint },
        line: { state: 'open', canStart: false, blocked: 'already_linked' },
        attempt: null,
      };
    }

    const inspection = await this.inspectLine(link);
    if (inspection.state === 'open') await this.handleOpen(inspection.name, inspection.snap?.runtime);

    const attempt = this.attempts.get(link.Instance.name);
    const own = attempt && attempt.tokenId === link.id && !attempt.ended ? attempt : undefined;
    return {
      link: {
        state: 'active',
        expiresInMs,
        displayName: link.displayName,
        attemptsLeft: this.attemptsLeft(link, now),
        numberHint,
      },
      line: {
        state: inspection.state,
        canStart: inspection.blocked === null && this.attemptsLeft(link, now) > 0,
        blocked: inspection.blocked,
      },
      attempt: own ? this.describeAttempt(own, link) : null,
    };
  }

  public async start(token: unknown, body: { mode?: unknown; number?: unknown }): Promise<PublicAttempt> {
    const link = await this.authenticate(token);
    const now = this.clock();
    if (linkTokenState(link, now) !== 'active') return fail('already_linked');

    const mode = body?.mode;
    if (mode !== 'code' && mode !== 'qr') return fail('bad_request');

    let number: string | undefined;
    if (mode === 'code') {
      const parsed = parseLinkPhone(body.number);
      if (!parsed.ok) return fail('invalid_number');
      const pairing = toPairingNumber(parsed.digits, this.config.PAIRING_MX_PREFIX);
      if (!pairing.ok) return fail('invalid_number');
      if (link.expectedNumber && !equivalentNumbers(pairing.digits, link.expectedNumber)) return fail('invalid_number');
      number = pairing.digits;
    }

    const name = link.Instance.name;
    const existing = this.attempts.get(name);
    if (
      existing &&
      !existing.ended &&
      existing.tokenId === link.id &&
      existing.mode === mode &&
      existing.number === number
    ) {
      // Double tap, second tab or a reload: the attempt that is already running is the answer; no quota, no new socket.
      const running = this.monitor.getLineSnapshot(name);
      if (running && running.state !== 'open' && !running.requiresManualIntervention)
        return this.describeAttempt(existing, link);
    }

    const before = await this.inspectLine(link);
    if (before.state === 'finalizing') return fail('reconnecting');
    if (before.blocked) return fail(before.blocked);
    if (link.attemptCount >= this.config.ATTEMPTS_PER_TOKEN) return fail('attempts_exhausted');
    if (this.attemptsLeft(link, now) <= 0) {
      return fail(
        'rate_limited',
        link.windowStartedAt ? Math.max(1, link.windowStartedAt.getTime() + HOUR_MS - now) : undefined,
      );
    }

    const attempt: Attempt = {
      instanceName: name,
      tokenId: link.id,
      mode,
      number,
      startedAt: now,
      expiresAt: now + this.config.ATTEMPT_TTL_SECONDS * 1000,
      generation: 0,
      runtime: null,
      shownAt: null,
      finalizing: false,
    };
    const resetMode: ResetCredentialsMode = before.resetPaired ? 'any' : 'unpaired';

    try {
      await this.monitor.reconnectInstanceNow(name, number, {
        resetCredentials: resetMode,
        guard: async () => {
          const running = this.attempts.get(name);
          if (
            running &&
            !running.ended &&
            running.tokenId === link.id &&
            running.mode === mode &&
            running.number === number
          ) {
            const line = this.monitor.getLineSnapshot(name);
            if (line && line.state !== 'open' && !line.requiresManualIntervention) throw new ReuseAttempt(running);
          }
          const inside = await this.inspectLine(link);
          if (inside.state === 'finalizing') return fail('reconnecting');
          if (inside.blocked) return fail(inside.blocked);
          // The situation must be the one the request was authorised for.
          if (inside.resetPaired !== before.resetPaired || (inside.paired && !before.resetPaired))
            return fail('reconnecting');

          const quota = await this.consumeAttempt(link.id, 'start');
          if (!quota.ok) return this.failQuota(quota);

          // Registered inside the critical section so a concurrent start of another link sees it.
          const previous = this.attempts.get(name);
          if (previous) this.dropAttempt(previous, 'replaced');
          this.attempts.set(name, attempt);
          if (before.resetPaired) this.logger.warn({ evento: 'restablecimiento', enlace: link.id, instancia: name });
        },
      });
    } catch (error) {
      if (error instanceof ReuseAttempt) {
        const fresh = await this.prisma.linkToken.findUnique({ where: { id: link.id } });
        return this.describeAttempt(error.attempt as Attempt, (fresh ?? link) as LinkRow);
      }
      if (this.attempts.get(name) === attempt) this.dropAttempt(attempt, 'replaced');
      if (error instanceof LinkError) throw error;
      this.logger.error({
        evento: 'start_fallo',
        enlace: link.id,
        instancia: name,
        error: String((error as Error)?.message ?? error),
      });
      return fail('unavailable');
    }

    attempt.runtime = this.monitor.getLineSnapshot(name)?.runtime ?? null;
    this.armTtl(attempt);
    this.logger.info({
      evento: 'inicio',
      enlace: link.id,
      instancia: name,
      modo: mode,
      numero: number ? lastFour(number) : undefined,
    });

    const fresh = await this.prisma.linkToken.findUnique({ where: { id: link.id } });
    return this.describeAttempt(attempt, (fresh ?? link) as LinkRow);
  }

  public async code(token: unknown): Promise<PublicCode> {
    const link = await this.authenticate(token);
    const now = this.clock();
    const cfg = this.config;
    const resets = link.autoResets;
    const resetsLeft = this.resetsLeft(link);
    const base = { resetInMs: null, resets, resetsLeft };

    if (linkTokenState(link, now) === 'consumed') return { ...base, state: 'linked' };

    const name = link.Instance.name;
    const attempt = this.attempts.get(name);
    const own = attempt && attempt.tokenId === link.id && !attempt.ended ? attempt : undefined;
    if (!own) {
      const endedRecord = this.ended.get(link.id);
      if (endedRecord && now - endedRecord.at <= ENDED_MEMORY_MS) {
        return {
          ...base,
          state: endedRecord.reason === 'exhausted' ? 'exhausted' : 'failed',
          reason: endedRecord.reason,
        };
      }
      const line = this.monitor.getLineSnapshot(name);
      return { ...base, state: line?.state === 'open' ? 'linked' : 'idle' };
    }

    const snap = this.monitor.getLineSnapshot(name);
    if (!snap) return { ...base, state: 'failed', reason: 'failed' };
    if (snap.state === 'open') {
      await this.handleOpen(name, snap.runtime);
      return { ...base, state: 'linked' };
    }

    const paired = await this.monitor.isSessionPaired(name);
    if (paired) {
      this.markFinalizing(own);
      return { ...base, state: 'finalizing' };
    }

    // A different socket than the one this attempt knew: a reset (ours) or a takeover. Either way the clock restarts.
    if (snap.runtime !== own.runtime) {
      own.runtime = snap.runtime;
      own.shownAt = null;
      own.codeKey = undefined;
    }

    const qr = snap.qr;
    const value = own.mode === 'code' ? qr?.pairingCode : qr?.base64;
    if (!qr || qr.count < 1 || !value) return { ...base, state: 'waiting' };

    if (own.codeKey !== qr.count) {
      own.codeKey = qr.count;
      own.codeSeenAt = now;
    }
    if (own.shownAt === null) {
      own.shownAt = now;
      this.armReset(own);
    }

    const expiresInMs = Math.max(0, QR_RENEWAL_MS - (now - (own.codeSeenAt ?? now)));
    const resetInMs =
      own.resetTimer && cfg.MAX_AUTO_RESETS > 0
        ? Math.max(0, own.shownAt + cfg.RESET_AFTER_SECONDS * 1000 - now)
        : null;
    return {
      state: 'ready',
      ...(own.mode === 'code' ? { pairingCode: value } : { qr: value }),
      expiresInMs,
      resetInMs,
      resets,
      resetsLeft,
    };
  }

  // ------------------------------------------------------------------------------------------------ quotas

  private failQuota(quota: Quota): never {
    if (quota.reason === 'hourly') return fail('rate_limited', quota.retryAfterMs);
    return fail(quota.reason === 'resets' ? 'resets_exhausted' : 'attempts_exhausted');
  }

  // Atomic: two concurrent requests can never both take the last slot, because each slot is one conditional UPDATE.
  private async consumeAttempt(linkId: string, kind: 'start' | 'reset'): Promise<Quota> {
    const cfg = this.config;
    const now = this.clock();
    const at = new Date(now);
    const windowStart = new Date(now - HOUR_MS);
    const resetWhere = kind === 'reset' ? { autoResets: { lt: cfg.MAX_AUTO_RESETS } } : {};
    const resetData = kind === 'reset' ? { autoResets: { increment: 1 } } : {};

    const newWindow = await this.prisma.linkToken.updateMany({
      where: {
        id: linkId,
        attemptCount: { lt: cfg.ATTEMPTS_PER_TOKEN },
        ...resetWhere,
        OR: [{ windowStartedAt: null }, { windowStartedAt: { lte: windowStart } }],
      },
      data: { windowStartedAt: at, windowAttempts: 1, attemptCount: { increment: 1 }, lastAttemptAt: at, ...resetData },
    });
    if (newWindow.count === 1) return { ok: true };

    const sameWindow = await this.prisma.linkToken.updateMany({
      where: {
        id: linkId,
        attemptCount: { lt: cfg.ATTEMPTS_PER_TOKEN },
        ...resetWhere,
        windowAttempts: { lt: cfg.ATTEMPTS_PER_HOUR },
        windowStartedAt: { gt: windowStart },
      },
      data: { windowAttempts: { increment: 1 }, attemptCount: { increment: 1 }, lastAttemptAt: at, ...resetData },
    });
    if (sameWindow.count === 1) return { ok: true };

    const row = await this.prisma.linkToken.findUnique({ where: { id: linkId } });
    if (!row || row.attemptCount >= cfg.ATTEMPTS_PER_TOKEN) return { ok: false, reason: 'lifetime' };
    if (kind === 'reset' && row.autoResets >= cfg.MAX_AUTO_RESETS) return { ok: false, reason: 'resets' };
    return {
      ok: false,
      reason: 'hourly',
      retryAfterMs: row.windowStartedAt ? Math.max(1, row.windowStartedAt.getTime() + HOUR_MS - now) : undefined,
    };
  }

  // ------------------------------------------------------------------------------------------------ attempts

  private describeAttempt(attempt: Attempt, link: LinkRow): PublicAttempt {
    return {
      mode: attempt.mode,
      expiresInMs: Math.max(0, attempt.expiresAt - this.clock()),
      resets: link.autoResets,
      resetsLeft: this.resetsLeft(link),
    };
  }

  private armTtl(attempt: Attempt) {
    const delay = Math.max(0, attempt.expiresAt - this.clock());
    attempt.ttlTimer = setTimeout(() => void this.endAttempt(attempt, 'expired'), delay);
    attempt.ttlTimer.unref?.();
  }

  // The reset clock starts when the code is first shown, and only while resets are allowed at all.
  private armReset(attempt: Attempt, afterMs?: number) {
    const cfg = this.config;
    if (cfg.MAX_AUTO_RESETS <= 0 || attempt.finalizing || attempt.ended) return;
    if (attempt.resetTimer) clearTimeout(attempt.resetTimer);
    const armedGeneration = attempt.generation;
    attempt.resetTimer = setTimeout(
      () => void this.autoReset(attempt, armedGeneration),
      afterMs ?? cfg.RESET_AFTER_SECONDS * 1000,
    );
    attempt.resetTimer.unref?.();
  }

  // The phone has started to link: from now on nothing may reset or end this socket.
  private markFinalizing(attempt: Attempt) {
    if (attempt.finalizing) return;
    attempt.finalizing = true;
    if (attempt.resetTimer) clearTimeout(attempt.resetTimer);
    attempt.resetTimer = undefined;
    if (attempt.forgetTimer) clearTimeout(attempt.forgetTimer);
    attempt.forgetTimer = setTimeout(() => {
      if (this.attempts.get(attempt.instanceName) === attempt) this.dropAttempt(attempt, 'expired');
    }, FORGET_FINALIZING_MS);
    attempt.forgetTimer.unref?.();
    this.logger.info({ evento: 'vinculando', enlace: attempt.tokenId, instancia: attempt.instanceName });
  }

  private clearTimers(attempt: Attempt) {
    for (const timer of [attempt.ttlTimer, attempt.resetTimer, attempt.forgetTimer]) if (timer) clearTimeout(timer);
    attempt.ttlTimer = attempt.resetTimer = attempt.forgetTimer = undefined;
  }

  private remember(attempt: Attempt, reason: EndReason) {
    this.ended.set(attempt.tokenId, { reason, at: this.clock() });
    if (this.ended.size > ENDED_MEMORY_MAX) {
      const oldest = this.ended.keys().next().value;
      if (oldest !== undefined) this.ended.delete(oldest);
    }
  }

  // Forget an attempt without touching the line (the line is handled by the caller, if at all).
  private dropAttempt(attempt: Attempt, reason: EndReason) {
    attempt.ended = reason;
    this.clearTimers(attempt);
    if (this.attempts.get(attempt.instanceName) === attempt) this.attempts.delete(attempt.instanceName);
    if (reason !== 'replaced') this.remember(attempt, reason);
  }

  // Ends an attempt that did not pair: the socket is disposed and the unpaired session dropped, in the monitor's
  // critical section, which refuses to touch an open line or a paired session.
  private async endAttempt(attempt: Attempt, reason: EndReason) {
    if (attempt.ended) return;
    if (attempt.finalizing) return;
    const outcome = await this.monitor.abortUnpairedConnection(attempt.instanceName);
    if (outcome === 'open' || outcome === 'paired' || outcome === 'busy') {
      // The phone got there first (or a reconnect is in flight): the attempt is not over.
      if (outcome !== 'busy') this.markFinalizing(attempt);
      return;
    }
    this.dropAttempt(attempt, reason);
    this.logger.info({
      evento: 'fin',
      enlace: attempt.tokenId,
      instancia: attempt.instanceName,
      motivo: reason,
      linea: outcome,
    });
  }

  // Reset to zero: a new socket and a new device identity with the same mode and number. Run by this service, never by
  // the generic reconnect watchdog (which leaves a runtime with a QR alone).
  private async autoReset(attempt: Attempt, armedGeneration: number) {
    if (attempt.ended || attempt.finalizing || attempt.generation !== armedGeneration) return;
    const name = attempt.instanceName;
    const cfg = this.config;

    const stop: { reason: string | null } = { reason: null };
    try {
      const link = (await this.prisma.linkToken.findUnique({ where: { id: attempt.tokenId } })) as LinkRow | null;
      if (!link || linkTokenState(link, this.clock()) !== 'active') {
        await this.endAttempt(attempt, 'revoked');
        return;
      }
      if (link.autoResets >= cfg.MAX_AUTO_RESETS) {
        await this.endAttempt(attempt, 'exhausted');
        return;
      }

      await this.monitor.reconnectInstanceNow(name, attempt.number, {
        resetCredentials: 'unpaired',
        guard: async () => {
          // Everything is re-checked here, inside the critical section, right before the destructive step.
          if (attempt.ended || attempt.generation !== armedGeneration) {
            stop.reason = 'stale';
            throw new LinkError('bad_request', 'stale');
          }
          const snap = this.monitor.getLineSnapshot(name);
          const reason =
            !snap || snap.integration !== Integration.WHATSAPP_BAILEYS
              ? 'missing'
              : snap.state === 'open'
                ? 'open'
                : snap.reconnecting
                  ? 'busy'
                  : snap.runtime !== attempt.runtime
                    ? 'replaced'
                    : (await this.monitor.isSessionPaired(name))
                      ? 'finalizing'
                      : null;
          if (reason) {
            stop.reason = reason;
            throw new LinkError('bad_request', reason);
          }
          const quota = await this.consumeAttempt(attempt.tokenId, 'reset');
          if (!quota.ok) {
            stop.reason = quota.reason === 'hourly' ? 'rate_limited' : 'exhausted';
            throw new LinkError('bad_request', stop.reason);
          }
        },
      });
    } catch (error) {
      if (stop.reason === 'finalizing' || stop.reason === 'open') {
        if (!attempt.ended) this.markFinalizing(attempt);
        return;
      }
      if (stop.reason === 'stale' || stop.reason === 'replaced' || stop.reason === 'missing') return;
      if (stop.reason === 'busy') {
        // Another reconnect of this line is in flight: look again in a few seconds instead of giving the attempt up.
        this.armReset(attempt, RESET_RETRY_MS);
        return;
      }
      if (stop.reason === 'rate_limited' || stop.reason === 'exhausted') {
        await this.endAttempt(attempt, stop.reason === 'exhausted' ? 'exhausted' : 'rate_limited');
        return;
      }
      this.logger.error({
        evento: 'reinicio_fallo',
        enlace: attempt.tokenId,
        instancia: name,
        error: String((error as Error)?.message ?? error),
      });
      await this.endAttempt(attempt, 'failed');
      return;
    }

    attempt.generation++;
    attempt.shownAt = null;
    attempt.codeKey = undefined;
    attempt.runtime = this.monitor.getLineSnapshot(name)?.runtime ?? null;
    this.logger.warn({
      evento: 'reinicio',
      enlace: attempt.tokenId,
      instancia: name,
      modo: attempt.mode,
      numero: attempt.number ? lastFour(attempt.number) : undefined,
    });
  }

  // ------------------------------------------------------------------------------------------------ open

  // The line reached "open": the link is used up. If it declared the number it expects and the account that opened is
  // someone else's, the session is logged out and the link revoked: the link was handed to a customer, not to anyone.
  private handleOpen(instanceName: string, runtime: any): Promise<void> {
    const running = this.opening.get(instanceName);
    if (running) return running;
    const task = this.consumeOnOpen(instanceName, runtime)
      .catch((error) =>
        this.logger.error({
          evento: 'apertura_fallo',
          instancia: instanceName,
          error: String(error?.message ?? error),
        }),
      )
      .finally(() => this.opening.delete(instanceName));
    this.opening.set(instanceName, task);
    return task;
  }

  private async consumeOnOpen(instanceName: string, runtime: any) {
    const instance = await this.prisma.instance.findFirst({
      where: { name: instanceName, clientName: this.clientName },
      select: { id: true },
    });
    if (!instance) return;

    const now = this.clock();
    const active = (await this.prisma.linkToken.findMany({
      where: { instanceId: instance.id, consumedAt: null, revokedAt: null, expiresAt: { gt: new Date(now) } },
    })) as LinkRow[];
    const attempt = this.attempts.get(instanceName);
    const used = attempt ? active.find((link) => link.id === attempt.tokenId) : undefined;

    if (used?.expectedNumber) {
      const owner = ownerDigitsOf(runtime);
      // Fail closed: a link that declared who it is for does not keep a session whose owner cannot be confirmed.
      if (!owner || !equivalentNumbers(owner, used.expectedNumber)) {
        await this.prisma.linkToken.updateMany({
          where: { id: used.id, revokedAt: null },
          data: { revokedAt: new Date(now) },
        });
        if (attempt) this.dropAttempt(attempt, 'replaced');
        this.logger.warn({
          evento: 'dueno_distinto',
          enlace: used.id,
          instancia: instanceName,
          esperado: lastFour(used.expectedNumber),
          obtenido: owner ? lastFour(owner) : 'desconocido',
        });
        try {
          await this.monitor.forceLogout(instanceName);
        } catch (error) {
          this.logger.error({
            evento: 'logout_fallo',
            enlace: used.id,
            instancia: instanceName,
            error: String((error as Error)?.message ?? error),
          });
        }
        return;
      }
    }

    if (active.length > 0) {
      await this.prisma.linkToken.updateMany({
        where: { id: { in: active.map((link) => link.id) }, consumedAt: null, revokedAt: null },
        data: { consumedAt: new Date(now) },
      });
      this.logger.info({ evento: 'consumido', instancia: instanceName, enlaces: active.length });
    }
    if (attempt) this.dropAttempt(attempt, 'replaced');
  }
}
