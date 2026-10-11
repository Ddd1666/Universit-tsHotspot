import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Schutz der lokalen API gegen fremde Webseiten im selben Browser:
 * 1. Host-Header-Prüfung (DNS-Rebinding),
 * 2. Origin-/Sec-Fetch-Site-Prüfung (CSRF),
 * 3. zufälliges Token pro Start (Header `x-hotspot-token`; nur für Downloads/SSE alternativ `?t=`).
 * Server bindet zusätzlich ausschließlich an 127.0.0.1.
 */

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self'; object-src 'none'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/** Endpunkte, die das Token auch als Query-Parameter akzeptieren (EventSource / <a href> können keine Header setzen). */
const QUERY_TOKEN_ROUTES = [/^\/api\/events(\?|$)/, /^\/api\/sources\/\d+\/file(\?|$)/];

export interface SecurityOptions {
  token: string;
  getPort: () => number;
  devOrigins: string[];
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function allowedHosts(opts: SecurityOptions): Set<string> {
  const port = opts.getPort();
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  for (const o of opts.devOrigins) hosts.add(new URL(o).host);
  return hosts;
}

export function allowedOrigins(opts: SecurityOptions): Set<string> {
  const port = opts.getPort();
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...opts.devOrigins]);
}

function deny(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).header('cache-control', 'no-store').send({ error: code, message });
}

export function registerSecurity(app: FastifyInstance, opts: SecurityOptions): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const host = (request.headers.host ?? '').toLowerCase();
    if (!allowedHosts(opts).has(host)) return deny(reply, 403, 'invalid_host', 'Unerwarteter Host-Header');

    const url = request.raw.url ?? '/';
    if (!url.startsWith('/api/')) return;

    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins(opts).has(origin)) return deny(reply, 403, 'invalid_origin', 'Fremde Herkunft (Origin) blockiert');
    const site = request.headers['sec-fetch-site'];
    if (site === 'cross-site') return deny(reply, 403, 'cross_site', 'Cross-Site-Anfrage blockiert');

    const headerToken = request.headers['x-hotspot-token'];
    let token = typeof headerToken === 'string' ? headerToken : '';
    if (!token && request.method === 'GET' && QUERY_TOKEN_ROUTES.some((re) => re.test(url))) {
      token = new URL(url, 'http://x').searchParams.get('t') ?? '';
    }
    if (!token || !safeEqual(token, opts.token)) return deny(reply, 401, 'invalid_token', 'Ungültiges oder fehlendes Zugriffstoken – Seite neu laden');
  });

  app.addHook('onSend', async (request, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', CSP);
    if ((request.raw.url ?? '').startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });
}
