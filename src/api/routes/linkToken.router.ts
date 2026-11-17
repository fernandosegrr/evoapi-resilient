import { LinkError, LinkService } from '@api/services/link.service';
import { configService, Link } from '@config/env.config';
import { resolveClientIp } from '@utils/clientIp';
import { linkTokenCreateSchema } from '@validate/link.schema';
import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { validate } from 'jsonschema';

// Administration of self-service links. The routes carry no ":instanceName", so authGuard.apikey lets ONLY the global
// apikey through: an instance's own key cannot create, list or revoke links.
export class LinkTokenRouter {
  public readonly router: Router = Router();

  constructor(
    private readonly linkService: LinkService,
    ...guards: RequestHandler[]
  ) {
    this.router.use((_req, res, next) => {
      // The create response carries the one and only copy of the raw token.
      res.set('Cache-Control', 'no-store');
      next();
    });

    this.router
      .post(
        '/',
        ...guards,
        this.handle(async (req, res) => {
          const result = validate(req.body ?? {}, linkTokenCreateSchema);
          if (!result.valid) {
            return res.status(400).json({
              status: 400,
              error: 'bad_request',
              response: { message: result.errors.map((error) => error.stack.replace('instance.', '')) },
            });
          }
          return res.status(201).json(await this.linkService.createLink(req.body));
        }),
      )
      .get(
        '/',
        ...guards,
        this.handle(async (req, res) => {
          const instanceName = typeof req.query.instanceName === 'string' ? req.query.instanceName : '';
          return res.status(200).json({ links: await this.linkService.listLinks(instanceName) });
        }),
      )
      .get(
        '/_diagnostics',
        ...guards,
        this.handle(async (req, res) => {
          const cfg = configService.get<Link>('LINK');
          const resolved = resolveClientIp(
            req.headers['x-forwarded-for'],
            req.socket.remoteAddress,
            cfg.TRUST_PROXY_HOPS,
          );
          return res.status(200).json({
            peer: req.socket.remoteAddress ?? null,
            xForwardedFor: req.headers['x-forwarded-for'] ?? null,
            hops: cfg.TRUST_PROXY_HOPS,
            resolved,
            sessionStore: this.linkService.describeSessionStore(),
            publicEnabled: cfg.PUBLIC_ENABLED,
            publicBaseUrl: cfg.PUBLIC_BASE_URL,
          });
        }),
      )
      .delete(
        '/:linkId',
        ...guards,
        this.handle(async (req, res) => {
          return res.status(200).json(await this.linkService.revokeLink(req.params.linkId));
        }),
      );
  }

  // Expected failures keep their own status and never reach the global error handler (and its error webhook).
  private handle(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        await handler(req, res);
      } catch (error) {
        if (error instanceof LinkError) {
          return res
            .status(error.status)
            .json({ status: error.status, error: error.code, response: { message: error.message } });
        }
        next(error);
      }
    };
  }
}
