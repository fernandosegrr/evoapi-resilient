import { LinkError, LinkService } from '@api/services/link.service';
import { Link } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { resolveClientIp } from '@utils/clientIp';
import { LINK_TOKEN_PATTERN } from '@utils/linkToken';
import { SlidingWindowLimiter } from '@utils/rateLimiter';
import express, { NextFunction, Request, Response, Router } from 'express';

// Public, tokenised surface of the self-service link. It is mounted in main.ts BEFORE the global middleware and only when
// LINK_PUBLIC_ENABLED=true, because the global middleware is wrong for an unauthenticated endpoint:
//  - json({ limit: '136mb' }) would parse a huge body before anything is validated,
//  - cors({ origin: '*' }) would let any website call it from a visitor's browser,
//  - the telemetry middleware would send the request path to a third party,
//  - the error handler answers with err.message and fires the ERRORS_WEBHOOK.
// So this router brings its own 2 KB parser, no CORS, no telemetry and local error handling with generic bodies.

const BEARER = new RegExp(`^Bearer (${LINK_TOKEN_PATTERN.source.slice(1, -1)})$`, 'i');
const MINUTE = 60_000;
const HOUR = 3_600_000;

// Per-IP limits. Deliberately generous: many Mexican mobile customers share one carrier-grade NAT address, so these only
// stop floods. What protects a link is its 256-bit token and the per-link quotas in the database.
const IP_REQUESTS_PER_MINUTE = 120;
const IP_STARTS_PER_HOUR = 10;
const IP_INVALID_TOKENS_PER_WINDOW = 10;
const IP_INVALID_WINDOW_MS = 15 * MINUTE;
const MAX_TRACKED_IPS = 10_000;

export interface PublicLinkRouterOptions {
  linkService: Pick<LinkService, 'status' | 'start' | 'code'>;
  config: Link;
  now?: () => number;
}

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  Expires: '0',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function createPublicLinkRouter(options: PublicLinkRouterOptions): Router {
  const { linkService, config } = options;
  const now = options.now ?? Date.now;
  const logger = new Logger('PublicLink');
  const router = Router();

  const totals = new SlidingWindowLimiter({
    limit: IP_REQUESTS_PER_MINUTE,
    windowMs: MINUTE,
    maxKeys: MAX_TRACKED_IPS,
    now,
  });
  const starts = new SlidingWindowLimiter({ limit: IP_STARTS_PER_HOUR, windowMs: HOUR, maxKeys: MAX_TRACKED_IPS, now });
  const invalid = new SlidingWindowLimiter({
    limit: IP_INVALID_TOKENS_PER_WINDOW,
    windowMs: IP_INVALID_WINDOW_MS,
    maxKeys: MAX_TRACKED_IPS,
    now,
  });
  const sweeper = setInterval(() => {
    totals.sweep();
    starts.sweep();
    invalid.sweep();
  }, MINUTE);
  sweeper.unref?.();

  const send = (res: Response, status: number, body: unknown, retryAfterMs?: number) => {
    if (retryAfterMs !== undefined) res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    return res.status(status).json(body);
  };
  const sendError = (res: Response, error: LinkError) =>
    send(res, error.status, { error: error.code, message: error.message }, error.retryAfterMs);

  // Headers on EVERY response of this router, success or error. No Access-Control-* header is ever set: only the page
  // served from this same origin can call it.
  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.removeHeader('X-Powered-By');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.set(name, value);
    next();
  });

  router.use((req: Request, res: Response, next: NextFunction) => {
    const ip = resolveClientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress, config.TRUST_PROXY_HOPS).ip;
    res.locals.ip = ip;

    const total = totals.hit(ip);
    if (!total.allowed)
      return sendError(res, new LinkError('rate_limited', 'Demasiadas solicitudes.', total.retryAfterMs));
    // An address that keeps presenting tokens that do not exist is cut off before any database work.
    const blocked = invalid.peek(ip);
    if (!blocked.allowed)
      return sendError(res, new LinkError('rate_limited', 'Demasiadas solicitudes.', blocked.retryAfterMs));
    next();
  });

  // Own body parser: 2 KB, JSON only.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST') return next();
    if (!req.is('application/json'))
      return send(res, 415, { error: 'unsupported_media_type', message: 'Solo se admite JSON.' });
    next();
  });
  router.use(express.json({ limit: '2kb', type: 'application/json', strict: true }));

  const token = (req: Request): string | null => {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? BEARER.exec(header.trim()) : null;
    return match ? match[1] : null;
  };

  const handle =
    (name: string, action: (req: Request, bearer: string) => Promise<{ status: number; body: unknown }>) =>
    async (req: Request, res: Response) => {
      const ip: string = res.locals.ip;
      const bearer = token(req);
      try {
        // No usable token never reaches the service: same answer, no work.
        if (!bearer) throw new LinkError('invalid_link', 'Enlace inválido o vencido.');
        const result = await action(req, bearer);
        return send(res, result.status, result.body);
      } catch (error) {
        if (error instanceof LinkError) {
          if (error.code === 'invalid_link') {
            const before = invalid.peek(ip).allowed;
            invalid.record(ip);
            if (before && !invalid.peek(ip).allowed)
              logger.warn({ evento: 'ip_bloqueada', motivo: 'enlaces_invalidos', ip });
          }
          return sendError(res, error);
        }
        // Never the message, the stack, the token or the headers: they can carry secrets and are not for this audience.
        logger.error({ evento: 'error', ruta: name, ip, error: error instanceof Error ? error.name : 'unknown' });
        return send(res, 500, { error: 'unavailable', message: 'No pudimos procesar la solicitud. Intenta de nuevo.' });
      }
    };

  // Inert: they only read.
  router.get(
    '/status',
    handle('status', async (_req, bearer) => ({ status: 200, body: await linkService.status(bearer) })),
  );
  router.get(
    '/code',
    handle('code', async (_req, bearer) => ({ status: 200, body: await linkService.code(bearer) })),
  );

  // The only route that starts anything: POST, with the token in the Authorization header, after the person pressed a button.
  router.post('/start', async (req: Request, res: Response) => {
    const ip: string = res.locals.ip;
    const allowance = starts.hit(ip);
    if (!allowance.allowed)
      return sendError(res, new LinkError('rate_limited', 'Demasiados intentos.', allowance.retryAfterMs));
    // The body is checked inside the handler, after the token: an unauthenticated caller always gets the same 401.
    const run = handle('start', async (request, bearer) => {
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new LinkError('bad_request', 'La solicitud no es válida.');
      }
      return {
        status: 202,
        body: { attempt: await linkService.start(bearer, { mode: body.mode, number: body.number }) },
      };
    });
    return run(req, res);
  });

  // Anything else under /public/link is simply not there (not a 401: that would confirm the prefix exists for tokens).
  router.use((_req: Request, res: Response) => send(res, 404, { error: 'not_found', message: 'No encontrado.' }));

  // Body-parser failures and anything unexpected end here with generic bodies; nothing reaches the global handler.
  // Express recognises an error handler by its four parameters, so the last one must stay even though it is unused.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  router.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    if (error?.type === 'entity.too.large')
      return send(res, 413, { error: 'payload_too_large', message: 'La solicitud es demasiado grande.' });
    if (
      error?.type === 'entity.parse.failed' ||
      error?.type === 'encoding.unsupported' ||
      error?.type === 'charset.unsupported'
    ) {
      return send(res, 400, { error: 'bad_request', message: 'La solicitud no es válida.' });
    }
    logger.error({ evento: 'error_inesperado', error: error instanceof Error ? error.name : 'unknown' });
    return send(res, 500, { error: 'unavailable', message: 'No pudimos procesar la solicitud. Intenta de nuevo.' });
  });

  return router;
}
