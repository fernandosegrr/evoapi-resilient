import { InstanceDto } from '@api/dto/instance.dto';
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { channelController } from '@api/server.module';
import { Events, Integration } from '@api/types/wa.types';
import {
  CacheConf,
  Chatwoot,
  ConfigService,
  Database,
  DelInstance,
  ProviderSession,
  WaReconnect,
} from '@config/env.config';
import { Logger } from '@config/logger.config';
import { INSTANCE_DIR, STORE_DIR } from '@config/path.config';
import { BadRequestException, NotFoundException } from '@exceptions';
import EventEmitter2 from 'eventemitter2';
import { rmSync } from 'fs';
import { join } from 'path';

import { CacheService } from './cache.service';

type ReconnectContext = {
  statusCode?: number;
  lastDisconnect?: unknown;
};

type ReconnectState = ReconnectContext & {
  attempts: number;
  generation?: number;
  halted: boolean;
  inProgress: boolean;
  pendingReconnect: boolean;
  source?: any;
  timeout?: NodeJS.Timeout;
  lastFailureReason?: string;
  watchdogTimeout?: NodeJS.Timeout;
  // Phone number a caller asked a pairing code for (reconnectInstanceNow). Retries reuse it so a transient failure
  // while the person is typing the code does not silently turn the attempt into a QR one.
  number?: string;
};

// Used by the self-service link feature (src/api/services/link.service.ts).
export type ResetCredentialsMode =
  // Clean the stored session only if it is NOT paired with a phone (re-checked right before cleaning).
  | 'unpaired'
  // Clean any stored session unless the line is open (re-checked right before cleaning). Needs an explicit permission.
  | 'any';

export type ReconnectOptions = {
  // Runs inside the per-instance lifecycle mutex before anything is torn down; throwing aborts the reconnect untouched.
  guard?: () => Promise<void> | void;
  // Clean the persisted session between disposing the old runtime and creating the new one, on this first attempt only.
  resetCredentials?: ResetCredentialsMode;
};

export type LineSnapshot = {
  // The runtime object itself, so a caller can tell a renewal (same socket) from a reset (new socket).
  runtime: unknown;
  integration: string | null;
  state: 'open' | 'close' | 'connecting' | 'unknown';
  reconnecting: boolean;
  requiresManualIntervention: boolean;
  reason: string | null;
  qr: { count: number; pairingCode: string | null; base64: string | null } | null;
};

export type AbortResult = 'aborted' | 'open' | 'paired' | 'busy' | 'missing' | 'unsupported';

type OpenListener = (instanceName: string, runtime: any) => void | Promise<void>;

// A stored session is paired when the phone already accepted the pairing code (creds.registered, set only by the
// pairing-code flow) or pair-success arrived (creds.account, set by both flows). Session.creds is JSON-encoded twice;
// anything unreadable counts as paired so that nothing is ever destroyed on a doubt.
export function sessionCredsArePaired(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === '') return false;
  let value: any = raw;
  for (let pass = 0; pass < 3 && typeof value === 'string'; pass++) {
    try {
      value = JSON.parse(value);
    } catch {
      return true;
    }
  }
  if (!value || typeof value !== 'object') return true;
  return Boolean(value.registered || value.account);
}

type InstanceLifecycleState = {
  deleting: boolean;
  generation: number;
};

// A reconnect attempt can get stuck forever if the underlying transport (e.g. a proxy TCP
// connect that never resolves nor rejects) never surfaces an error. Without this bound, the
// attempt's promise never settles: state.inProgress stays true forever, the backoff loop can
// never schedule the next attempt or reach markManualIntervention, and deleteInstance — which
// shares the same per-instance lifecycle mutex — waits on that same never-settling promise.
class ReconnectAttemptTimeoutError extends Error {
  constructor(instanceName: string, timeoutMs: number) {
    super(`Instance "${instanceName}" reconnect attempt did not complete within ${timeoutMs}ms`);
    this.name = 'ReconnectAttemptTimeoutError';
  }
}

export class WAMonitoringService {
  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly prismaRepository: PrismaRepository,
    private readonly providerFiles: ProviderFiles,
    private readonly cache: CacheService,
    private readonly chatwootCache: CacheService,
    private readonly baileysCache: CacheService,
  ) {
    this.removeInstance();
    this.noConnection();

    Object.assign(this.db, configService.get<Database>('DATABASE'));
    Object.assign(this.redis, configService.get<CacheConf>('CACHE'));

    (this as any).providerSession = Object.freeze(configService.get<ProviderSession>('PROVIDER'));
  }

  private readonly db: Partial<Database> = {};
  private readonly redis: Partial<CacheConf> = {};

  private readonly logger = new Logger('WAMonitoringService');
  public readonly waInstances: Record<string, any> = {};
  private readonly delInstanceTimeouts: Record<string, NodeJS.Timeout> = {};
  private readonly reconnectStates = new Map<string, ReconnectState>();
  private readonly lifecycleStates = new Map<string, InstanceLifecycleState>();
  private readonly lifecycleOperations = new Map<string, Promise<void>>();
  private readonly deleteOperations = new Map<string, Promise<void>>();

  private readonly providerSession: ProviderSession;
  private readonly openListeners: OpenListener[] = [];

  private getLifecycleState(instanceName: string) {
    let state = this.lifecycleStates.get(instanceName);
    if (!state) {
      state = { deleting: false, generation: 0 };
      this.lifecycleStates.set(instanceName, state);
    }

    return state;
  }

  private beginRuntimeOperation(instanceName: string) {
    const state = this.getLifecycleState(instanceName);
    if (state.deleting) {
      throw new BadRequestException(`Instance "${instanceName}" is being deleted`);
    }

    state.generation++;
    return state.generation;
  }

  private markInstanceDeleting(instanceName: string) {
    const state = this.getLifecycleState(instanceName);
    state.deleting = true;
    state.generation++;
    return state.generation;
  }

  private isGenerationCurrent(instanceName: string, generation: number) {
    const state = this.lifecycleStates.get(instanceName);
    return Boolean(state && !state.deleting && state.generation === generation);
  }

  private runLifecycleExclusive<T>(instanceName: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleOperations.get(instanceName) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );

    this.lifecycleOperations.set(instanceName, settled);

    return result.finally(() => {
      if (this.lifecycleOperations.get(instanceName) === settled) {
        this.lifecycleOperations.delete(instanceName);
      }
    });
  }

  private async discardRuntime(instanceName: string, instance: any, reason: string) {
    if (this.waInstances[instanceName] === instance) {
      delete this.waInstances[instanceName];
    }

    try {
      await instance?.disposeConnection?.(reason);
    } catch (error) {
      this.logger.error({ local: 'discardRuntime', instanceName, error });
    }
  }

  public registerNewInstanceRuntime(instanceName: string, instance: any) {
    const state = this.getLifecycleState(instanceName);
    if (state.deleting) {
      throw new BadRequestException(`Instance "${instanceName}" is being deleted`);
    }
    if (this.waInstances[instanceName]) {
      throw new BadRequestException(`Instance "${instanceName}" already has an active runtime`);
    }

    const generation = this.beginRuntimeOperation(instanceName);

    (instance as any).lifecycleGeneration = generation;
    this.waInstances[instanceName] = instance;

    return generation;
  }

  public isRuntimeCurrent(instanceName: string, source: any) {
    const generation = source?.lifecycleGeneration;
    return (
      typeof generation === 'number' &&
      this.isGenerationCurrent(instanceName, generation) &&
      this.waInstances[instanceName] === source
    );
  }

  public delInstanceTime(instance: string) {
    const time = this.configService.get<DelInstance>('DEL_INSTANCE');
    if (typeof time === 'number' && time > 0) {
      // Clear previous timeout if exists
      if (this.delInstanceTimeouts[instance]) {
        clearTimeout(this.delInstanceTimeouts[instance]);
      }

      // Set new timeout and store reference
      this.delInstanceTimeouts[instance] = setTimeout(
        async () => {
          try {
            if (this.waInstances[instance]?.connectionStatus?.state !== 'open') {
              if (this.waInstances[instance]?.connectionStatus?.state === 'connecting') {
                if ((await this.waInstances[instance].integration) === Integration.WHATSAPP_BAILEYS) {
                  await this.waInstances[instance]?.client?.logout('Log out instance: ' + instance);
                  this.waInstances[instance]?.client?.ws?.close();
                  this.waInstances[instance]?.client?.end(undefined);
                }
                await this.deleteInstance(instance);
              } else {
                await this.deleteInstance(instance);
              }
            }
          } finally {
            // Clean up timeout reference
            delete this.delInstanceTimeouts[instance];
          }
        },
        1000 * 60 * time,
      );
    }
  }

  public clearDelInstanceTime(instance: string) {
    if (this.delInstanceTimeouts[instance]) {
      clearTimeout(this.delInstanceTimeouts[instance]);
      delete this.delInstanceTimeouts[instance];
    }
  }

  private getReconnectConfig() {
    const config = this.configService.get<WaReconnect>('WA_RECONNECT');
    const initialDelayMs = Number.isFinite(config.INITIAL_DELAY_MS) ? Math.max(1000, config.INITIAL_DELAY_MS) : 5000;

    return {
      enabled: config.ENABLED,
      maxAttempts: Number.isFinite(config.MAX_ATTEMPTS) ? Math.max(1, Math.floor(config.MAX_ATTEMPTS)) : 6,
      initialDelayMs,
      maxDelayMs: Number.isFinite(config.MAX_DELAY_MS) ? Math.max(initialDelayMs, config.MAX_DELAY_MS) : 60000,
      jitterFactor: Number.isFinite(config.JITTER_FACTOR) ? Math.min(1, Math.max(0, config.JITTER_FACTOR)) : 0.2,
      attemptTimeoutMs: Number.isFinite(config.ATTEMPT_TIMEOUT_MS) ? Math.max(5000, config.ATTEMPT_TIMEOUT_MS) : 45000,
    };
  }

  private reconnectDelay(attempt: number) {
    const config = this.getReconnectConfig();
    const exponentialDelay = Math.min(config.initialDelayMs * 2 ** Math.max(0, attempt - 1), config.maxDelayMs);
    const jitter = exponentialDelay * config.jitterFactor;

    return Math.round(exponentialDelay - jitter + Math.random() * jitter * 2);
  }

  private createReconnectingPlaceholder(instanceName: string, currentInstance: any) {
    const message = `Instance "${instanceName}" is reconnecting`;
    const unavailable: any = new Proxy(
      () => {
        throw new BadRequestException(message);
      },
      {
        apply: () => {
          throw new BadRequestException(message);
        },
        get: (_target, property) => (property === 'then' ? undefined : unavailable),
      },
    );

    const placeholder = {
      reconnecting: true,
      sourceRuntime: currentInstance?.sourceRuntime ?? currentInstance,
      instanceName,
      instanceId: currentInstance?.instanceId,
      integration: currentInstance?.integration,
      instance: {
        name: instanceName,
        id: currentInstance?.instanceId,
        integration: currentInstance?.integration,
        qrcode: { count: 0 },
      },
      connectionStatus: { state: 'connecting', message: 'instance reconnecting' },
      stateConnection: { state: 'connecting', message: 'instance reconnecting' },
      qrCode: { message: 'instance reconnecting' },
      client: unavailable,
    };

    return new Proxy(placeholder, {
      get: (target, property, receiver) =>
        Reflect.has(target, property) ? Reflect.get(target, property, receiver) : unavailable,
    });
  }

  public cancelReconnect(instanceName: string) {
    const state = this.reconnectStates.get(instanceName);
    if (state?.timeout) {
      clearTimeout(state.timeout);
      state.timeout = undefined;
    }
    if (state?.watchdogTimeout) {
      clearTimeout(state.watchdogTimeout);
      state.watchdogTimeout = undefined;
    }
    if (state) state.pendingReconnect = false;
    this.reconnectStates.delete(instanceName);
  }

  public markReconnectSucceeded(instanceName: string, source: any) {
    if (!this.isRuntimeCurrent(instanceName, source)) return;

    const attempts = this.reconnectStates.get(instanceName)?.attempts ?? 0;
    this.cancelReconnect(instanceName);
    this.notifyOpen(instanceName, source);

    if (attempts > 0) {
      this.logger.info(`Instance "${instanceName}" recovered after ${attempts} reconnect attempt(s)`);
    }
  }

  public scheduleReconnect(instanceName: string, source: any, context: ReconnectContext = {}) {
    if (!this.isRuntimeCurrent(instanceName, source)) return;

    let state = this.reconnectStates.get(instanceName);
    if (!state) {
      state = {
        attempts: 0,
        halted: false,
        inProgress: false,
        pendingReconnect: false,
      };
      this.reconnectStates.set(instanceName, state);
    }

    state.source = source;
    state.statusCode = context.statusCode;
    state.lastDisconnect = context.lastDisconnect;

    if (state.inProgress) {
      state.pendingReconnect = true;
      return;
    }

    this.queueReconnect(instanceName, state);
  }

  private queueReconnect(instanceName: string, state: ReconnectState) {
    if (
      this.getLifecycleState(instanceName).deleting ||
      this.reconnectStates.get(instanceName) !== state ||
      state.timeout ||
      state.inProgress ||
      state.halted
    ) {
      return;
    }

    const config = this.getReconnectConfig();
    if (!config.enabled || state.attempts >= config.maxAttempts) {
      state.halted = true;
      void this.markManualIntervention(instanceName, state);
      return;
    }

    state.attempts++;
    const reconnectDelayMs = this.reconnectDelay(state.attempts);

    this.logger.warn(
      `Instance "${instanceName}" reconnect attempt ${state.attempts}/${config.maxAttempts} ` +
        `scheduled in ${reconnectDelayMs}ms`,
    );

    state.timeout = setTimeout(() => {
      state.timeout = undefined;
      if (this.reconnectStates.get(instanceName) !== state || this.getLifecycleState(instanceName).deleting) return;

      const generation = this.beginRuntimeOperation(instanceName);
      state.generation = generation;
      void this.runLifecycleExclusive(instanceName, () =>
        this.recreateInstance(instanceName, state, generation, true, this.pairingNumberFor(state)),
      );
    }, reconnectDelayMs);
  }

  // A Baileys runtime that is still "connecting" but already received a QR is not stuck: it is waiting for a person to
  // scan it or type the pairing code, which can take far longer than attemptTimeoutMs. instance.qrcode.count is bumped
  // on every `qr` event, and WhatsApp only sends one after the handshake succeeded. The case the watchdogs exist for —
  // a transport that never answers (e.g. a proxy that accepts TCP and goes silent) — never emits a QR, so it stays covered.
  private isAwaitingPairing(runtime: any): boolean {
    if (!runtime || runtime.reconnecting) return false;

    try {
      const status = runtime.connectionStatus;
      const state = typeof status === 'string' ? status : status?.state;
      const qrCount = runtime.qrCode?.count;
      return state === 'connecting' && typeof qrCount === 'number' && qrCount > 0;
    } catch {
      return false;
    }
  }

  // The number a retry keeps requesting a pairing code for. It only applies until the phone accepts the code: once
  // creds.registered (the phone submitted the code) or creds.account (pair-success) is set, the next connect is a plain
  // login and the number must not be passed again (it would also change the browser descriptor of the login).
  private pairingNumberFor(state: ReconnectState): string | undefined {
    if (!state.number) return undefined;

    const creds = state.source?.instance?.authState?.state?.creds;
    return creds?.registered || creds?.account ? undefined : state.number;
  }

  // Attempt failures are classified so markManualIntervention can report *why* it gave up.
  // A proxy failure (either the fail-closed config/agent checks in createProxyOptions, or this
  // attempt simply timing out while a proxy is enabled for the instance) is reported as
  // 'proxy_unavailable'; anything else keeps the generic exhausted-attempts reason.
  private classifyReconnectFailure(instanceName: string, error: unknown): string {
    const name = (error as any)?.name;
    if (name === 'ProxyUnavailableError') return 'proxy_unavailable';
    if (name === 'ReconnectAttemptTimeoutError' && this.waInstances[instanceName]?.localProxy?.enabled) {
      return 'proxy_unavailable';
    }
    return 'automatic_reconnect_exhausted';
  }

  private async recreateInstance(
    instanceName: string,
    state: ReconnectState,
    generation: number,
    retryOnFailure: boolean,
    number?: string,
    resetCredentials?: ResetCredentialsMode,
  ) {
    if (this.reconnectStates.get(instanceName) !== state || !this.isGenerationCurrent(instanceName, generation)) return;

    const currentInstance = this.waInstances[instanceName];
    if (state.source && currentInstance !== state.source) return;

    state.inProgress = true;
    state.pendingReconnect = false;
    let reconnectError: unknown;

    const { attemptTimeoutMs } = this.getReconnectConfig();
    let timeoutHandle: NodeJS.Timeout | undefined;
    const attemptWork = this.performReconnectAttempt(
      instanceName,
      state,
      generation,
      currentInstance,
      number,
      resetCredentials,
    );

    try {
      await Promise.race([
        attemptWork,
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new ReconnectAttemptTimeoutError(instanceName, attemptTimeoutMs));
          }, attemptTimeoutMs);
        }),
      ]);
    } catch (error) {
      const runtime = this.waInstances[instanceName];
      if (
        error instanceof ReconnectAttemptTimeoutError &&
        runtime !== currentInstance && // a runtime this attempt created, not the dead one it was replacing
        this.isAwaitingPairing(runtime)
      ) {
        // Something after the socket started (not the WhatsApp handshake: a QR already arrived) overran the budget.
        // The runtime is a healthy pairing wait, so keep it and let the attempt finish in the background.
        this.logger.warn(
          `Instance "${instanceName}" reconnect attempt ${state.attempts} overran ${attemptTimeoutMs}ms but its ` +
            `runtime already issued a QR and is waiting for pairing — keeping it`,
        );
        state.source = runtime;
        attemptWork.catch((attemptError) => {
          this.logger.warn({
            local: 'recreateInstance.slowAttempt',
            instanceName,
            attempt: state.attempts,
            error: attemptError,
          });
        });
      } else {
        reconnectError = error;
        this.logger.error({
          local: 'recreateInstance',
          instanceName,
          attempt: state.attempts,
          error,
        });
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      state.inProgress = false;
    }

    if (reconnectError instanceof ReconnectAttemptTimeoutError) {
      // The attempt is still running in the background (e.g. stuck in a proxy TCP connect).
      // Proactively try to tear down whatever runtime it left behind instead of waiting for
      // the next attempt's generation check to discard it passively. Never let this block the
      // current attempt's own resolution, and never let it surface as an unhandled rejection.
      const stuckRuntime = this.waInstances[instanceName];
      if (stuckRuntime && !stuckRuntime.reconnecting) {
        void stuckRuntime.disposeConnection?.('Reconnect attempt timed out').catch((error: unknown) => {
          this.logger.warn({ local: 'recreateInstance.abortStuckAttempt', instanceName, error });
        });
      }
      attemptWork.catch((error) => {
        this.logger.warn({ local: 'recreateInstance.staleAttempt', instanceName, attempt: state.attempts, error });
      });
    }

    if (this.reconnectStates.get(instanceName) !== state || !this.isGenerationCurrent(instanceName, generation)) return;

    if (reconnectError) {
      // Every failure — proxy-related or not, scheduled or an explicit reconnectInstanceNow() —
      // feeds the same attempts/backoff state machine: it counts as one failed attempt, and
      // queueReconnect decides uniformly whether to schedule the next try or, once maxAttempts
      // is exhausted, finalize via markManualIntervention. This is what keeps a failing proxy
      // from short-circuiting the backoff loop on its very first failure.
      state.source = this.waInstances[instanceName];
      state.lastFailureReason = this.classifyReconnectFailure(instanceName, reconnectError);

      this.queueReconnect(instanceName, state);

      if (!retryOnFailure) throw reconnectError;
      return;
    }

    if (state.pendingReconnect) {
      state.pendingReconnect = false;
      this.queueReconnect(instanceName, state);
      return;
    }

    // No error was thrown — createClient() only *starts* the socket, it never waits for the
    // handshake to actually finish (confirmed live: connectToWhatsapp() through a proxy that
    // accepts the TCP connection but never answers the CONNECT/TLS handshake still resolves in
    // ~1-2s). Baileys' own connection.update handler normally reacts to whatever happens next
    // (markReconnectSucceeded on 'open', a fresh scheduleReconnect on 'close') — but if the
    // transport never reaches either terminal state at all, neither of those ever fires and the
    // instance is left parked at "connecting" forever, invisible to this whole state machine.
    // This is the actual shape of the reported bug (confirmed live against a proxy that accepts
    // TCP but never responds): arm a watchdog that checks back after attemptTimeoutMs and, if
    // still stuck, treats it as a failed attempt too.
    this.armStuckConnectingWatchdog(instanceName, state, generation, this.waInstances[instanceName]);
  }

  private armStuckConnectingWatchdog(instanceName: string, state: ReconnectState, generation: number, runtime: any) {
    if (!runtime) return;

    const { attemptTimeoutMs } = this.getReconnectConfig();
    if (state.watchdogTimeout) clearTimeout(state.watchdogTimeout);

    state.watchdogTimeout = setTimeout(() => {
      state.watchdogTimeout = undefined;

      if (this.reconnectStates.get(instanceName) !== state || !this.isGenerationCurrent(instanceName, generation)) {
        return; // deleted, superseded, or already resolved by markReconnectSucceeded/cancelReconnect
      }
      if (state.inProgress || state.timeout) return; // another attempt is already in flight/scheduled
      if (this.waInstances[instanceName] !== runtime) return; // no longer the runtime this watchdog is guarding

      const connectionState = runtime.connectionStatus;
      const currentState = typeof connectionState === 'string' ? connectionState : connectionState?.state;
      if (currentState !== 'connecting') return; // reached 'open'/'close' already; the normal handlers took it from here
      if (this.isAwaitingPairing(runtime)) {
        // It reached WhatsApp and is waiting for someone to scan the QR / type the pairing code. Recycling it would
        // invalidate the code the person is typing; Baileys' own close events end a wait that is truly dead.
        this.logger.info(`Instance "${instanceName}" is waiting for pairing (QR already issued); watchdog not applied`);
        return;
      }

      this.logger.warn(
        `Instance "${instanceName}" reconnect attempt ${state.attempts} never reached open/close within ` +
          `${attemptTimeoutMs}ms (stuck at "connecting", likely an unresponsive proxy) — treating it as failed`,
      );

      state.source = runtime;
      state.lastFailureReason = runtime.localProxy?.enabled ? 'proxy_unavailable' : 'automatic_reconnect_exhausted';

      void runtime.disposeConnection?.('Reconnect attempt never reached open/close').catch((error: unknown) => {
        this.logger.warn({ local: 'armStuckConnectingWatchdog.disposeConnection', instanceName, error });
      });

      this.queueReconnect(instanceName, state);
    }, attemptTimeoutMs);
  }

  private async performReconnectAttempt(
    instanceName: string,
    state: ReconnectState,
    generation: number,
    currentInstance: any,
    number?: string,
    resetCredentials?: ResetCredentialsMode,
  ) {
    if (this.reconnectStates.get(instanceName) !== state || !this.isGenerationCurrent(instanceName, generation)) {
      return;
    }

    const clientName = this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;
    const storedInstance = await this.prismaRepository.instance.findFirst({
      where: { name: instanceName, clientName },
    });

    if (this.reconnectStates.get(instanceName) !== state || !this.isGenerationCurrent(instanceName, generation)) {
      return;
    }

    if (!storedInstance) {
      this.cancelReconnect(instanceName);
      return;
    }

    await this.prismaRepository.instance.update({
      where: { id: storedInstance.id },
      data: { connectionStatus: 'connecting' },
    });

    if (this.reconnectStates.get(instanceName) !== state || !this.isGenerationCurrent(instanceName, generation)) {
      return;
    }

    const reconnectingPlaceholder = this.createReconnectingPlaceholder(instanceName, currentInstance);
    (reconnectingPlaceholder as any).lifecycleGeneration = generation;
    if (this.waInstances[instanceName] === currentInstance) {
      this.waInstances[instanceName] = reconnectingPlaceholder;
    }

    if (!currentInstance?.reconnecting) {
      await currentInstance?.disposeConnection?.('Replacing dead Baileys runtime');
    }

    if (
      this.reconnectStates.get(instanceName) !== state ||
      !this.isGenerationCurrent(instanceName, generation) ||
      this.waInstances[instanceName] !== reconnectingPlaceholder
    ) {
      return;
    }

    // Only the first attempt of an explicit request cleans the session; retries never do. The previous runtime has just
    // been disposed, so nothing writes the stored session any more and what is on disk is what will be loaded next.
    let numberToUse = number;
    if (resetCredentials) {
      const outcome = await this.resetSessionBeforeConnect(
        instanceName,
        storedInstance.id,
        currentInstance,
        resetCredentials,
      );
      // A paired session is reconnected as a plain login: passing the number would only change its browser descriptor.
      if (outcome.paired) numberToUse = undefined;
      if (
        this.reconnectStates.get(instanceName) !== state ||
        !this.isGenerationCurrent(instanceName, generation) ||
        this.waInstances[instanceName] !== reconnectingPlaceholder
      ) {
        return;
      }
    }

    state.source = await this.setInstance(
      {
        instanceId: storedInstance.id,
        instanceName: storedInstance.name,
        integration: storedInstance.integration,
        token: storedInstance.token,
        number: storedInstance.number,
        businessId: storedInstance.businessId,
        ownerJid: storedInstance.ownerJid,
        connectionStatus: 'connecting',
      },
      true,
      numberToUse,
      generation,
    );
  }

  // Supersedes whatever attempt is in flight and registers a fresh reconnect state; callers then run recreateInstance.
  private prepareReconnect(instanceName: string, source: any, number?: string) {
    const generation = this.beginRuntimeOperation(instanceName);
    this.cancelReconnect(instanceName);

    const state: ReconnectState = {
      attempts: 0,
      halted: false,
      inProgress: false,
      pendingReconnect: false,
      source,
      generation,
      number: number || undefined,
    };
    this.reconnectStates.set(instanceName, state);

    return { state, generation };
  }

  public async reconnectInstanceNow(instanceName: string, number?: string, options: ReconnectOptions = {}) {
    if (!this.waInstances[instanceName]) throw new NotFoundException(`Instance "${instanceName}" not found`);

    if (options.guard) {
      // The check and the action share one critical section: nothing can change the line in between.
      await this.runLifecycleExclusive(instanceName, async () => {
        await options.guard();
        const source = this.waInstances[instanceName];
        if (!source) throw new NotFoundException(`Instance "${instanceName}" not found`);
        const { state, generation } = this.prepareReconnect(instanceName, source, number);
        await this.recreateInstance(instanceName, state, generation, false, number, options.resetCredentials);
      });
      return;
    }

    const { state, generation } = this.prepareReconnect(instanceName, this.waInstances[instanceName], number);
    await this.runLifecycleExclusive(instanceName, () =>
      this.recreateInstance(instanceName, state, generation, false, number, options.resetCredentials),
    );
  }

  // ---- Read-only view and controlled operations used by the self-service link (link.service.ts) ----

  // Credentials are only inspectable (and cleanable) when the session store is the database, with the same precedence as
  // defineAuthState in the Baileys service: provider files, then Redis, then Prisma.
  public usesDatabaseSessions(): boolean {
    if (this.providerSession?.ENABLED) return false;
    if (this.redis.REDIS?.ENABLED && this.redis.REDIS?.SAVE_INSTANCES) return false;
    return Boolean(this.db.SAVE_DATA?.INSTANCE);
  }

  public onInstanceOpen(listener: OpenListener) {
    this.openListeners.push(listener);
  }

  // Listeners must never be able to break connection handling.
  private notifyOpen(instanceName: string, runtime: any) {
    for (const listener of this.openListeners) {
      try {
        void Promise.resolve(listener(instanceName, runtime)).catch((error: unknown) => {
          this.logger.error({ local: 'notifyOpen', instanceName, error });
        });
      } catch (error) {
        this.logger.error({ local: 'notifyOpen', instanceName, error });
      }
    }
  }

  public getLineSnapshot(instanceName: string): LineSnapshot | null {
    const runtime = this.waInstances[instanceName];
    if (!runtime) return null;

    const status = runtime.connectionStatus;
    const details: any = typeof status === 'string' ? { state: status } : (status ?? {});
    const state = ['open', 'close', 'connecting'].includes(details.state) ? details.state : 'unknown';

    let qr: LineSnapshot['qr'] = null;
    if (!runtime.reconnecting) {
      try {
        const code = runtime.qrCode;
        qr = {
          count: typeof code?.count === 'number' ? code.count : 0,
          pairingCode: typeof code?.pairingCode === 'string' ? code.pairingCode : null,
          base64: typeof code?.base64 === 'string' ? code.base64 : null,
        };
      } catch {
        qr = null;
      }
    }

    return {
      runtime,
      integration: typeof runtime.integration === 'string' ? runtime.integration : null,
      state,
      reconnecting: runtime.reconnecting === true,
      requiresManualIntervention: details.requiresManualIntervention === true,
      reason: typeof details.reason === 'string' ? details.reason : null,
      qr,
    };
  }

  // Is there a session paired with a phone? In-memory credentials of the live runtime are the authority (Baileys updates
  // them in place); without them the stored session is read. When credentials cannot be inspected the answer is "yes".
  private async hasPairedSession(instanceName: string, instanceId: string | undefined, runtime: any): Promise<boolean> {
    if (!this.usesDatabaseSessions()) return true;

    const creds = runtime && !runtime.reconnecting ? runtime.instance?.authState?.state?.creds : undefined;
    if (creds && typeof creds === 'object') return Boolean(creds.registered || creds.account);

    let id = instanceId;
    if (!id) {
      const clientName = this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;
      id = (
        await this.prismaRepository.instance.findFirst({
          where: { name: instanceName, clientName },
          select: { id: true },
        })
      )?.id;
    }
    if (!id) return false;

    const row = await this.prismaRepository.session.findUnique({ where: { sessionId: id } });
    return sessionCredsArePaired(row?.creds);
  }

  public async isSessionPaired(instanceName: string): Promise<boolean> {
    const runtime = this.waInstances[instanceName];
    return this.hasPairedSession(instanceName, runtime?.instanceId, runtime);
  }

  // Runs between disposing the previous runtime and creating the next one. Never touches an open line, and in 'unpaired'
  // mode never touches a paired session. The decision is taken here, right before cleaning, not when the request began.
  private async resetSessionBeforeConnect(
    instanceName: string,
    instanceId: string,
    previousRuntime: any,
    mode: ResetCredentialsMode,
  ): Promise<{ cleaned: boolean; paired: boolean }> {
    const status = previousRuntime?.connectionStatus;
    const state = typeof status === 'string' ? status : status?.state;
    const paired = await this.hasPairedSession(instanceName, instanceId, previousRuntime);

    if (state === 'open') {
      this.logger.warn(`Instance "${instanceName}" is open: its session is not cleaned`);
      return { cleaned: false, paired: true };
    }
    if (mode === 'unpaired' && paired) {
      this.logger.warn(`Instance "${instanceName}" has a paired session: it is reconnected, not cleaned`);
      return { cleaned: false, paired: true };
    }
    if (!this.usesDatabaseSessions()) {
      this.logger.warn(`Instance "${instanceName}" session store is not the database: its session is not cleaned`);
      return { cleaned: false, paired };
    }

    await this.cleaningUp(instanceName, instanceId);
    await this.prismaRepository.instance.update({
      where: { id: instanceId },
      data: { connectionStatus: 'connecting' },
    });
    return { cleaned: true, paired: false };
  }

  // Ends a connection attempt that never paired: disposes the runtime, drops the unpaired session and leaves the line
  // closed. Everything is decided inside the per-instance mutex and refuses to touch an open or paired line.
  public async abortUnpairedConnection(instanceName: string): Promise<AbortResult> {
    if (!this.waInstances[instanceName]) return 'missing';
    if (!this.usesDatabaseSessions()) return 'unsupported';

    return this.runLifecycleExclusive<AbortResult>(instanceName, async () => {
      const runtime = this.waInstances[instanceName];
      if (!runtime) return 'missing';
      if (runtime.reconnecting) return 'busy';

      const status = runtime.connectionStatus;
      if ((typeof status === 'string' ? status : status?.state) === 'open') return 'open';
      if (await this.hasPairedSession(instanceName, runtime.instanceId, runtime)) return 'paired';

      // Supersede in-flight attempts and drop stale events of this runtime, but keep it registered as the current one.
      const generation = this.beginRuntimeOperation(instanceName);
      runtime.lifecycleGeneration = generation;
      this.cancelReconnect(instanceName);

      await runtime.disposeConnection?.('Link attempt ended');
      await this.cleaningUp(instanceName, runtime.instanceId);
      if (runtime.stateConnection) runtime.stateConnection = { state: 'close' };
      return 'aborted';
    });
  }

  // Same sequence as DELETE /instance/logout: stop reconnecting, then log the session out of WhatsApp.
  public async forceLogout(instanceName: string) {
    this.cancelReconnect(instanceName);
    await this.waInstances[instanceName]?.logoutInstance?.();
  }

  private async markManualIntervention(instanceName: string, state: ReconnectState) {
    if (
      this.getLifecycleState(instanceName).deleting ||
      this.reconnectStates.get(instanceName) !== state ||
      (state.generation !== undefined && !this.isGenerationCurrent(instanceName, state.generation))
    ) {
      return;
    }

    if (state.timeout) {
      clearTimeout(state.timeout);
      state.timeout = undefined;
    }
    state.pendingReconnect = false;
    state.halted = true;

    const instance = this.waInstances[instanceName];
    const disconnectionAt = new Date();
    const reason = state.lastFailureReason ?? 'automatic_reconnect_exhausted';
    let lastDisconnect: any;

    if (!instance?.reconnecting) {
      try {
        // Bounded so a stuck socket (the same kind of hang that can make an attempt time out)
        // can never stop this finalization step from reaching the DB update/webhook below.
        await Promise.race([
          instance?.disposeConnection?.('Automatic reconnect attempts exhausted'),
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('disposeConnection timed out during manual intervention')), 10_000),
          ),
        ]);
      } catch (error) {
        this.logger.error({ local: 'markManualIntervention.disposeConnection', instanceName, error });
      }
    }

    if (
      this.getLifecycleState(instanceName).deleting ||
      this.reconnectStates.get(instanceName) !== state ||
      (state.generation !== undefined && !this.isGenerationCurrent(instanceName, state.generation))
    ) {
      return;
    }

    try {
      lastDisconnect = JSON.parse(JSON.stringify(state.lastDisconnect));
    } catch {
      lastDisconnect = undefined;
    }

    const disconnectionObject = {
      reason,
      requiresManualIntervention: true,
      reconnectAttempts: state.attempts,
      ...(lastDisconnect === undefined ? {} : { lastDisconnect }),
    };

    if (instance?.stateConnection) {
      const manualInterventionState = {
        state: 'close',
        statusReason: state.statusCode,
        reason,
        requiresManualIntervention: true,
        reconnectAttempts: state.attempts,
      };
      instance.stateConnection = manualInterventionState;
      if (instance.reconnecting) instance.connectionStatus = manualInterventionState;
    }

    try {
      const clientName = this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;
      await this.prismaRepository.instance.updateMany({
        where: { name: instanceName, clientName },
        data: {
          connectionStatus: 'close',
          disconnectionAt,
          disconnectionReasonCode: state.statusCode,
          disconnectionObject,
        },
      });

      await instance?.sendDataWebhook(Events.CONNECTION_UPDATE, {
        instance: instanceName,
        state: 'close',
        statusReason: state.statusCode,
        reason,
        reconnectAttempts: state.attempts,
        requiresManualIntervention: true,
      });
    } catch (error) {
      this.logger.error({ local: 'markManualIntervention', instanceName, error });
    }

    this.logger.error(
      `Instance "${instanceName}" exhausted ${state.attempts} reconnect attempts (reason: ${reason}) and requires manual intervention`,
    );
  }

  public async instanceInfo(instanceNames?: string[]): Promise<any> {
    if (instanceNames && instanceNames.length > 0) {
      const inexistentInstances = instanceNames ? instanceNames.filter((instance) => !this.waInstances[instance]) : [];

      if (inexistentInstances.length > 0) {
        throw new NotFoundException(
          `Instance${inexistentInstances.length > 1 ? 's' : ''} "${inexistentInstances.join(', ')}" not found`,
        );
      }
    }

    const clientName = this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;

    const where =
      instanceNames && instanceNames.length > 0
        ? {
            name: {
              in: instanceNames,
            },
            clientName,
          }
        : { clientName };

    const instances = await this.prismaRepository.instance.findMany({
      where,
      include: {
        Chatwoot: true,
        Proxy: true,
        Rabbitmq: true,
        Nats: true,
        Sqs: true,
        Websocket: true,
        Setting: true,
        _count: {
          select: {
            Message: true,
            Contact: true,
            Chat: true,
          },
        },
      },
    });

    return instances;
  }

  public async instanceInfoById(instanceId?: string, number?: string) {
    let instanceName: string;
    if (instanceId) {
      instanceName = await this.prismaRepository.instance.findFirst({ where: { id: instanceId } }).then((r) => r?.name);
      if (!instanceName) {
        throw new NotFoundException(`Instance "${instanceId}" not found`);
      }
    } else if (number) {
      instanceName = await this.prismaRepository.instance.findFirst({ where: { number } }).then((r) => r?.name);
      if (!instanceName) {
        throw new NotFoundException(`Instance "${number}" not found`);
      }
    }

    if (!instanceName) {
      throw new NotFoundException(`Instance "${instanceId}" not found`);
    }

    if (instanceName && !this.waInstances[instanceName]) {
      throw new NotFoundException(`Instance "${instanceName}" not found`);
    }

    const instanceNames = instanceName ? [instanceName] : null;

    return this.instanceInfo(instanceNames);
  }

  public async cleaningUp(instanceName: string, knownInstanceId?: string) {
    let instanceDbId = knownInstanceId;
    if (this.db.SAVE_DATA.INSTANCE) {
      const findInstance = await this.prismaRepository.instance.findFirst({
        where: { name: instanceName },
      });

      if (findInstance) {
        const instance = await this.prismaRepository.instance.update({
          where: { name: instanceName },
          data: { connectionStatus: 'close' },
        });

        rmSync(join(INSTANCE_DIR, instance.id), { recursive: true, force: true });

        instanceDbId = instance.id;
        await this.prismaRepository.session.deleteMany({ where: { sessionId: instance.id } });
      }
    }

    if (this.redis.REDIS.ENABLED && this.redis.REDIS.SAVE_INSTANCES) {
      await this.cache.delete(instanceName);
      if (instanceDbId) {
        await this.cache.delete(instanceDbId);
      }
    }

    if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) {
      await this.chatwootCache?.deleteAll(instanceName);
    }
    if (instanceDbId) {
      await this.baileysCache.deleteAll(instanceDbId);
    }

    if (this.providerSession?.ENABLED) {
      const [, error] = await this.providerFiles.removeSession(instanceName);
      if (error) throw error;
    }
  }

  public async cleaningStoreData(instanceName: string) {
    if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) {
      const instancePath = join(STORE_DIR, 'chatwoot', instanceName);
      rmSync(instancePath, { recursive: true, force: true });
    }

    const instance = await this.prismaRepository.instance.findFirst({
      where: { name: instanceName },
    });

    if (!instance) return;

    rmSync(join(INSTANCE_DIR, instance.id), { recursive: true, force: true });

    await this.prismaRepository.session.deleteMany({ where: { sessionId: instance.id } });

    await this.prismaRepository.chat.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.contact.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.messageUpdate.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.message.deleteMany({ where: { instanceId: instance.id } });

    await this.prismaRepository.webhook.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.chatwoot.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.proxy.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.rabbitmq.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.nats.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.sqs.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.integrationSession.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.typebot.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.websocket.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.setting.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.label.deleteMany({ where: { instanceId: instance.id } });

    await this.prismaRepository.instance.delete({ where: { name: instanceName } });
  }

  public async loadInstance() {
    try {
      if (this.providerSession?.ENABLED) {
        await this.loadInstancesFromProvider();
      } else if (this.db.SAVE_DATA.INSTANCE) {
        await this.loadInstancesFromDatabasePostgres();
      } else if (this.redis.REDIS.ENABLED && this.redis.REDIS.SAVE_INSTANCES) {
        await this.loadInstancesFromRedis();
      }
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async saveInstance(data: any) {
    try {
      const clientName = await this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;
      await this.prismaRepository.instance.create({
        data: {
          id: data.instanceId,
          name: data.instanceName,
          ownerJid: data.ownerJid,
          profileName: data.profileName,
          profilePicUrl: data.profilePicUrl,
          connectionStatus:
            data.integration && data.integration === Integration.WHATSAPP_BAILEYS ? 'close' : (data.status ?? 'open'),
          number: data.number,
          integration: data.integration || Integration.WHATSAPP_BAILEYS,
          token: data.hash,
          clientName: clientName,
          businessId: data.businessId,
        },
      });
    } catch (error) {
      this.logger.error(error);
    }
  }

  public deleteInstance(instanceName: string): Promise<void> {
    const existingOperation = this.deleteOperations.get(instanceName);
    if (existingOperation) return existingOperation;

    const deletionGeneration = this.markInstanceDeleting(instanceName);
    this.cancelReconnect(instanceName);
    this.clearDelInstanceTime(instanceName);

    const operation = this.runLifecycleExclusive(instanceName, async () => {
      const registeredRuntime = this.waInstances[instanceName];
      const runtime = registeredRuntime?.reconnecting ? registeredRuntime.sourceRuntime : registeredRuntime;
      const cleanupErrors: unknown[] = [];
      let webhookSnapshot: any = {
        enabled: false,
        events: [],
        instanceId: runtime?.instanceId,
      };

      try {
        if (runtime?.instanceId) {
          const webhook = await this.prismaRepository.webhook.findUnique({
            where: { instanceId: runtime.instanceId },
            select: {
              enabled: true,
              events: true,
              url: true,
              headers: true,
              webhookByEvents: true,
              webhookBase64: true,
            },
          });

          if (webhook) webhookSnapshot = { ...webhook, instanceId: runtime.instanceId };
        }
      } catch (error) {
        cleanupErrors.push(error);
        this.logger.error({ local: 'deleteInstance.webhookSnapshot', instanceName, error });
      }

      try {
        await runtime?.disposeConnection?.('Instance deleted', true);
      } catch (error) {
        cleanupErrors.push(error);
        this.logger.error({ local: 'deleteInstance.disposeConnection', instanceName, error });
      }

      const lifecycle = this.lifecycleStates.get(instanceName);
      if (!lifecycle || !lifecycle.deleting || lifecycle.generation !== deletionGeneration) {
        throw new BadRequestException(`Deletion of instance "${instanceName}" was superseded`);
      }

      try {
        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && !runtime?.reconnecting) {
          runtime?.clearCacheChatwoot?.();
        }
      } catch (error) {
        cleanupErrors.push(error);
        this.logger.error({ local: 'deleteInstance.chatwootCache', instanceName, error });
      }

      if (this.waInstances[instanceName] === registeredRuntime) {
        delete this.waInstances[instanceName];
      }

      const webhookDelivery = {
        timeoutMs: 5_000,
        maxAttempts: 3,
        initialDelaySeconds: 1,
        maxDelaySeconds: 5,
        throwOnFailure: true,
        webhookSnapshot,
      };

      for (const [event, data] of [
        [Events.INSTANCE_DELETE, { instanceName, instanceId: runtime?.instanceId }],
        [Events.REMOVE_INSTANCE, null],
      ] as const) {
        try {
          await runtime?.sendDataWebhook?.(event, data, true, undefined, undefined, webhookDelivery);
        } catch (error) {
          cleanupErrors.push(error);
          this.logger.error({ local: 'deleteInstance.webhook', instanceName, event, error });
        }
      }

      try {
        await this.cleaningUp(instanceName, runtime?.instanceId);
      } catch (error) {
        cleanupErrors.push(error);
        this.logger.error({ local: 'deleteInstance.cleaningUp', instanceName, error });
      }

      try {
        await this.cleaningStoreData(instanceName);
      } catch (error) {
        cleanupErrors.push(error);
        this.logger.error({ local: 'deleteInstance.cleaningStoreData', instanceName, error });
      }

      if (cleanupErrors.length > 0) {
        const details = cleanupErrors
          .map((error) => (error instanceof Error ? error.message : String(error)))
          .join('; ');
        throw new Error(`Instance "${instanceName}" cleanup failed: ${details}`);
      }

      lifecycle.deleting = false;
      this.logger.warn(`Instance "${instanceName}" - REMOVED`);
    });

    this.deleteOperations.set(instanceName, operation);

    return operation.finally(() => {
      if (this.deleteOperations.get(instanceName) === operation) {
        this.deleteOperations.delete(instanceName);
      }
    });
  }

  private async setInstance(
    instanceData: InstanceDto,
    shouldConnect = instanceData.connectionStatus === 'open' || instanceData.connectionStatus === 'connecting',
    number?: string,
    generation = this.beginRuntimeOperation(instanceData.instanceName),
  ) {
    const instance = channelController.init(instanceData, {
      configService: this.configService,
      eventEmitter: this.eventEmitter,
      prismaRepository: this.prismaRepository,
      cache: this.cache,
      chatwootCache: this.chatwootCache,
      baileysCache: this.baileysCache,
      providerFiles: this.providerFiles,
    });

    if (!instance) return;

    instance.setInstance({
      instanceId: instanceData.instanceId,
      instanceName: instanceData.instanceName,
      integration: instanceData.integration,
      token: instanceData.token,
      number: instanceData.number,
      businessId: instanceData.businessId,
      ownerJid: instanceData.ownerJid,
    });

    (instance as any).lifecycleGeneration = generation;
    if (!this.isGenerationCurrent(instanceData.instanceName, generation)) {
      await this.discardRuntime(instanceData.instanceName, instance, 'Discarding stale runtime before registration');
      return;
    }

    // Register before connecting so connection events can identify this runtime.
    this.waInstances[instanceData.instanceName] = instance;

    if (shouldConnect) {
      this.logger.info(
        `Auto-connecting instance "${instanceData.instanceName}" (status: ${instanceData.connectionStatus})`,
      );
      await instance.connectToWhatsapp(number);

      if (!this.isRuntimeCurrent(instanceData.instanceName, instance)) {
        await this.discardRuntime(instanceData.instanceName, instance, 'Discarding stale runtime after connection');
        return;
      }
    } else {
      this.logger.info(
        `Skipping auto-connect for instance "${instanceData.instanceName}" (status: ${instanceData.connectionStatus || 'close'})`,
      );
    }

    return instance;
  }

  private async loadInstancesFromRedis() {
    const keys = await this.cache.keys();

    if (keys?.length > 0) {
      await Promise.all(
        keys.map(async (k) => {
          const instanceData = await this.prismaRepository.instance.findUnique({
            where: { id: k.split(':')[1] },
          });

          if (!instanceData) {
            return;
          }

          const instance = {
            instanceId: k.split(':')[1],
            instanceName: k.split(':')[2],
            integration: instanceData.integration,
            token: instanceData.token,
            number: instanceData.number,
            businessId: instanceData.businessId,
            connectionStatus: instanceData.connectionStatus as any, // Pass connection status
          };

          await this.setInstance(instance);
        }),
      );
    }
  }

  private async loadInstancesFromDatabasePostgres() {
    const clientName = await this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;

    const instances = await this.prismaRepository.instance.findMany({
      where: { clientName: clientName },
    });

    if (instances.length === 0) {
      return;
    }

    await Promise.all(
      instances.map(async (instance) => {
        await this.setInstance({
          instanceId: instance.id,
          instanceName: instance.name,
          integration: instance.integration,
          token: instance.token,
          number: instance.number,
          businessId: instance.businessId,
          ownerJid: instance.ownerJid,
          connectionStatus: instance.connectionStatus as any, // Pass connection status
        });
      }),
    );
  }

  private async loadInstancesFromProvider() {
    const [instances] = await this.providerFiles.allInstances();

    if (!instances?.data) {
      return;
    }

    await Promise.all(
      instances?.data?.map(async (instanceId: string) => {
        const instance = await this.prismaRepository.instance.findUnique({
          where: { id: instanceId },
        });

        await this.setInstance({
          instanceId: instance.id,
          instanceName: instance.name,
          integration: instance.integration,
          token: instance.token,
          businessId: instance.businessId,
          connectionStatus: instance.connectionStatus as any, // Pass connection status
        });
      }),
    );
  }

  private removeInstance() {
    this.eventEmitter.on('remove.instance', (instanceName: string) => {
      void this.deleteInstance(instanceName).catch((error) => {
        this.logger.error({ local: 'removeInstance', instanceName, error });
      });
    });

    this.eventEmitter.on('logout.instance', async (instanceName: string) => {
      this.cancelReconnect(instanceName);
      this.clearDelInstanceTime(instanceName);

      try {
        await this.waInstances[instanceName]?.sendDataWebhook(Events.LOGOUT_INSTANCE, null);
      } catch (error) {
        this.logger.error({ local: 'logoutInstance.webhook', instanceName, error });
      }

      try {
        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) {
          this.waInstances[instanceName]?.clearCacheChatwoot();
        }

        await this.cleaningUp(instanceName);
      } finally {
        this.logger.warn(`Instance "${instanceName}" - LOGOUT`);
      }
    });
  }

  private noConnection() {
    this.eventEmitter.on('no.connection', async (instanceName) => {
      try {
        await this.waInstances[instanceName]?.client?.logout('Log out instance: ' + instanceName);

        this.waInstances[instanceName]?.client?.ws?.close();

        this.waInstances[instanceName].instance.qrcode = { count: 0 };
        this.waInstances[instanceName].stateConnection.state = 'close';
      } catch (error) {
        this.logger.error({
          localError: 'noConnection',
          warn: 'Error deleting instance from memory.',
          error,
        });
      } finally {
        this.logger.warn(`Instance "${instanceName}" - NOT CONNECTION`);
      }
    });
  }
}
