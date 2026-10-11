import type { FastifyReply } from 'fastify';
import { CSP, SECURITY_HEADERS } from './security.ts';

export interface SseChannel {
  send(event: string, data: unknown): void;
  comment(text: string): void;
  close(): void;
  readonly closed: boolean;
  onClose(fn: () => void): void;
}

/** Server-Sent Events über die rohe Node-Response (Fastify-Reply wird übernommen). */
export function openSse(reply: FastifyReply): SseChannel {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-security-policy': CSP,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();
  let closed = false;
  const closeHandlers: (() => void)[] = [];
  res.on('close', () => {
    closed = true;
    for (const fn of closeHandlers) fn();
  });
  return {
    get closed() {
      return closed;
    },
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      if (!closed) res.write(`: ${text}\n\n`);
    },
    close() {
      if (!closed) res.end();
    },
    onClose(fn) {
      closeHandlers.push(fn);
    },
  };
}
