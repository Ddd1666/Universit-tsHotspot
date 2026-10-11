import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function walk(dir: string, base = dir, out = new Map<string, string>()): Map<string, string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile() && !entry.name.endsWith('.map')) out.set('/' + path.relative(base, full).split(path.sep).join('/'), full);
  }
  return out;
}

/**
 * Liefert das gebaute Web-UI aus. Nur Dateien aus einer beim Start erstellten Positivliste werden ausgeliefert
 * -> Path-Traversal ist konstruktionsbedingt ausgeschlossen. Das Zugriffstoken wird in index.html eingesetzt.
 */
export function registerWeb(app: FastifyInstance, webDir: string | null, token: string): void {
  if (!webDir) {
    app.get('/', async (_req, reply) =>
      reply.type('text/plain; charset=utf-8').send('Uni-Hotspot API läuft. Web-UI nicht gebaut: "npm run build" ausführen (oder "npm start").'),
    );
    return;
  }
  const files = walk(webDir);
  const indexHtml = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8').replace('__HOTSPOT_TOKEN__', token);

  app.get('/*', async (request, reply) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent((request.raw.url ?? '/').split('?')[0]!);
    } catch {
      return reply.code(400).type('text/plain').send('Bad request');
    }
    if (urlPath.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
    const file = urlPath === '/' || urlPath === '/index.html' ? null : files.get(urlPath);
    if (!file) {
      if (path.extname(urlPath)) return reply.code(404).type('text/plain').send('Not found');
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(indexHtml);
    }
    const ext = path.extname(file).toLowerCase();
    reply.type(MIME[ext] ?? 'application/octet-stream');
    reply.header('cache-control', urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    return reply.send(fs.createReadStream(file));
  });
}
