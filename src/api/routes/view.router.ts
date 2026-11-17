import { RouterBroker } from '@api/abstract/abstract.router';
import express, { Router } from 'express';
import path from 'path';

// The customer-facing self-service link page. It is the same single-page app as the rest of the manager (same origin as
// the administrator's saved session), so it is served with a strict policy: scripts only from this origin and none
// inline, no framing, no caching, no referrer and no indexing. The token lives in the URL fragment, which the browser
// never sends, so this response is identical for everybody.
export const LINK_PAGE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

export class ViewsRouter extends RouterBroker {
  public readonly router: Router;

  constructor() {
    super();
    this.router = Router();

    const basePath = path.join(process.cwd(), 'manager', 'dist');
    const indexPath = path.join(basePath, 'index.html');

    // Before the static handler so that nothing can answer /manager/link without these headers.
    this.router.get(['/link', '/link/*'], (req, res) => {
      for (const [name, value] of Object.entries(LINK_PAGE_HEADERS)) res.set(name, value);
      res.sendFile(indexPath, { etag: false, lastModified: false, cacheControl: false });
    });

    this.router.use(express.static(basePath));

    this.router.get('*', (req, res) => {
      res.sendFile(indexPath);
    });
  }
}
