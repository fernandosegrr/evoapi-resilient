import { createHmac, randomBytes } from 'crypto';

/** A step that takes longer than this is reported ([SLOW-STEP] warning and the diagnostics ring buffer). */
export const SLOW_STEP_THRESHOLD_MS = 2_000;
export const SLOW_STEP_RING_SIZE = 50;
export const QUEUE_WAIT_WINDOW_MS = 15 * 60 * 1000;
const BUCKET_MS = 60 * 1000;

// A phone number is easy to brute-force from a plain hash, so chats are shown with a keyed hash whose key lives
// only in this process: stable enough to correlate entries while the process runs, useless outside of it.
const chatHashKey = randomBytes(16);

/** `pn:3fa9c1d2`, `group:91b0c7aa`, `status`...: tells chats apart without exposing the number. Never throws. */
export function abbreviateJid(jid?: string | null): string | undefined {
  if (!jid || typeof jid !== 'string') return undefined;
  if (jid === 'status@broadcast') return 'status';

  const kind = jid.endsWith('@s.whatsapp.net')
    ? 'pn'
    : jid.endsWith('@lid')
      ? 'lid'
      : jid.endsWith('@g.us')
        ? 'group'
        : jid.endsWith('@newsletter')
          ? 'newsletter'
          : jid.endsWith('@broadcast')
            ? 'broadcast'
            : 'other';

  return `${kind}:${createHmac('sha256', chatHashKey).update(jid).digest('hex').slice(0, 8)}`;
}

export type SlowStep = {
  step: string;
  durationMs: number;
  /** ISO-8601, UTC. */
  at: string;
  /** Abbreviated chat, never a number or any message text. */
  chat?: string;
};

export type DeliveryProbes = {
  eventQueueDepth?: () => number;
  webhookQueueDepth?: () => number;
  profilePictures?: () => { active: number; queued: number; cached: number };
};

/**
 * Highest value seen over a sliding window, kept in one-minute buckets so memory never grows. The window therefore
 * has one-minute resolution: a value can linger up to a minute past the nominal 15.
 */
class RollingMax {
  private readonly buckets = new Map<number, number>();

  record(value: number, nowMs: number) {
    const bucket = Math.floor(nowMs / BUCKET_MS);
    this.buckets.set(bucket, Math.max(this.buckets.get(bucket) ?? 0, value));
    this.prune(nowMs);
  }

  max(nowMs: number): number {
    this.prune(nowMs);
    let max = 0;
    for (const value of this.buckets.values()) max = Math.max(max, value);
    return max;
  }

  private prune(nowMs: number) {
    const oldest = Math.floor((nowMs - QUEUE_WAIT_WINDOW_MS) / BUCKET_MS);
    for (const bucket of this.buckets.keys()) if (bucket < oldest) this.buckets.delete(bucket);
  }
}

/** In-memory delivery health of one instance. Cheap, makes no database or network call and never throws. */
export class InstanceDeliveryMetrics {
  private readonly eventWait = new RollingMax();
  private readonly webhookWait = new RollingMax();
  private readonly ring: (SlowStep | undefined)[] = new Array(SLOW_STEP_RING_SIZE).fill(undefined);
  private slowStepCount = 0;
  private probes: DeliveryProbes = {};

  constructor(
    public readonly instanceName: string,
    private readonly now: () => number = Date.now,
  ) {}

  public attach(probes: DeliveryProbes) {
    this.probes = probes;
  }

  public recordEventQueueWait(waitMs: number) {
    this.safely(() => this.eventWait.record(waitMs, this.now()));
  }

  public recordWebhookQueueWait(waitMs: number) {
    this.safely(() => this.webhookWait.record(waitMs, this.now()));
  }

  /** Keeps the step in the ring buffer when it was slow. Returns whether it was. */
  public recordStep(step: string, durationMs: number, jid?: string | null): boolean {
    if (!(durationMs >= SLOW_STEP_THRESHOLD_MS)) return false;

    this.safely(() => {
      this.ring[this.slowStepCount % SLOW_STEP_RING_SIZE] = {
        step,
        durationMs: Math.round(durationMs),
        at: new Date(this.now()).toISOString(),
        chat: abbreviateJid(jid),
      };
      this.slowStepCount++;
    });

    return true;
  }

  public snapshot() {
    const nowMs = this.now();

    const recent: SlowStep[] = [];
    const stored = Math.min(this.slowStepCount, SLOW_STEP_RING_SIZE);
    for (let i = 1; i <= stored; i++) {
      const entry = this.ring[(this.slowStepCount - i) % SLOW_STEP_RING_SIZE];
      if (entry) recent.push(entry);
    }

    return {
      instanceName: this.instanceName,
      generatedAt: new Date(nowMs).toISOString(),
      windowMinutes: QUEUE_WAIT_WINDOW_MS / BUCKET_MS,
      eventQueue: {
        depth: this.read(() => this.probes.eventQueueDepth?.() ?? 0, 0),
        maxWaitMsLast15m: this.read(() => this.eventWait.max(nowMs), 0),
      },
      webhookQueue: {
        depth: this.read(() => this.probes.webhookQueueDepth?.() ?? 0, 0),
        maxWaitMsLast15m: this.read(() => this.webhookWait.max(nowMs), 0),
      },
      profilePictures: this.read(() => this.probes.profilePictures?.() ?? { active: 0, queued: 0, cached: 0 }, {
        active: 0,
        queued: 0,
        cached: 0,
      }),
      slowSteps: {
        thresholdMs: SLOW_STEP_THRESHOLD_MS,
        totalSinceStart: this.slowStepCount,
        /** Newest first, at most SLOW_STEP_RING_SIZE. */
        recent,
      },
    };
  }

  private safely(work: () => void) {
    try {
      work();
    } catch {
      // measuring delivery must never affect delivery
    }
  }

  private read<T>(work: () => T, fallback: T): T {
    try {
      return work();
    } catch {
      return fallback;
    }
  }
}

export class DeliveryMetricsRegistry {
  private readonly instances = new Map<string, InstanceDeliveryMetrics>();

  constructor(private readonly now: () => number = Date.now) {}

  public forInstance(instanceName: string): InstanceDeliveryMetrics {
    let metrics = this.instances.get(instanceName);
    if (!metrics) {
      metrics = new InstanceDeliveryMetrics(instanceName, this.now);
      this.instances.set(instanceName, metrics);
    }
    return metrics;
  }

  public snapshotAll() {
    return [...this.instances.values()].map((metrics) => metrics.snapshot());
  }
}

export const deliveryMetrics = new DeliveryMetricsRegistry();

/** Per-message timeline for the optional fine-grained log (WEBHOOK_TIMING_LOGS). */
export class MessageTimeline {
  private readonly steps: Record<string, number> = {};
  private readonly startedAtMs: number;

  constructor(
    public readonly keyId: string | undefined,
    public readonly jid: string | undefined,
    public readonly fromMe: boolean | undefined,
    public readonly receivedAtMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAtMs = now();
  }

  public add(step: string, durationMs: number) {
    this.steps[step] = Math.round((this.steps[step] ?? 0) + durationMs);
  }

  public summary() {
    const nowMs = this.now();
    return {
      keyId: this.keyId,
      chat: abbreviateJid(this.jid),
      fromMe: this.fromMe,
      // time between the events reaching Evolution and this message starting to be handled (chain wait plus the
      // messages handled before it in the same batch)
      delayBeforeHandlingMs: Math.max(0, this.startedAtMs - this.receivedAtMs),
      handlingMs: nowMs - this.startedAtMs,
      steps: { ...this.steps },
    };
  }
}
