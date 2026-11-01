// HTTP server: static map page, JSON snapshot and a Server-Sent Events stream
// that pushes train changes once a second.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { constants as zlibConstants, createGzip, gzipSync } from 'node:zlib';
import type { Feed } from './feeds/feed.ts';
import type { TrainSource } from './engine/source.ts';
import type { TrainStore } from './engine/trainStore.ts';

export interface AppOptions {
  feed: Feed;
  store: TrainStore;
  /** More trains to show alongside the main feed (e.g. the Tube). */
  sources?: TrainSource[];
  publicDir: string;
  pushIntervalMs?: number;
  /** Detail for one train (stops, route geometry); undefined if unknown. */
  describe?: (trainId: string) => unknown;
  /** Track geometry between two location keys (on a TfL line's own track when `line` is given); null if unknown. */
  path?: (fromKey: string, toKey: string, line?: string) => unknown;
}

const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
// Smaller bodies are not worth compressing.
const GZIP_MIN_BYTES = 1024;
// Track paths asked for in one /api/paths request.
const MAX_PATHS_PER_REQUEST = 200;

/** A browser on the live stream; `out` is gzip in front of the response when it accepts that. */
interface StreamClient {
  res: http.ServerResponse;
  out: Writable;
}

const acceptsGzip = (req: http.IncomingMessage) => /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createApp({ feed, store, sources = [], publicDir, pushIntervalMs = 1000, describe, path: trackPath }: AppOptions) {
  const clients = new Set<StreamClient>();
  const root = path.resolve(publicDir);

  const status = () => ({
    feed: feed.kind,
    ...feed.status(),
    stats: store.stats,
    sources: Object.fromEntries(sources.map((s) => [s.name, s.status()])),
    serverTime: Date.now(),
  });
  const snapshot = () => [...store.snapshot(), ...sources.flatMap((s) => s.snapshot())];

  const send = (client: StreamClient, event: string, data: unknown) => {
    // A client that stopped reading (laptop asleep, dead link) would buffer
    // every delta in memory; drop it and let EventSource reconnect for a
    // fresh snapshot.
    if (client.res.writableLength + client.out.writableLength > MAX_BUFFERED_BYTES) {
      clients.delete(client);
      client.res.destroy();
      return;
    }
    client.out.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcast = (event: string, data: unknown) => {
    for (const client of clients) send(client, event, data);
  };

  feed.start((messages, receivedAt) => {
    for (const m of messages) {
      try {
        store.apply(m, receivedAt);
      } catch (err) {
        console.warn(`[store] skipped a message: ${(err as Error).message}`);
      }
    }
  });

  for (const s of sources) s.start();

  const pump = setInterval(() => {
    store.prune(Date.now());
    const { upserts, removals } = store.drainChanges();
    for (const s of sources) {
      const more = s.drainChanges();
      upserts.push(...more.upserts);
      removals.push(...more.removals);
    }
    if (upserts.length || removals.length) broadcast('delta', { upserts, removals, serverTime: Date.now() });
  }, pushIntervalMs);
  const statusTimer = setInterval(() => broadcast('status', status()), 5000);
  const keepalive = setInterval(() => { for (const client of clients) client.out.write(': ping\n\n'); }, 20_000);

  // The train list is ~0.5 MB of JSON; gzip makes it a tenth of that.
  const json = (req: http.IncomingMessage, res: http.ServerResponse, body: unknown, status = 200) => {
    let data: string | Buffer = JSON.stringify(body);
    const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
    if (data.length >= GZIP_MIN_BYTES && acceptsGzip(req)) {
      data = gzipSync(data);
      headers['Content-Encoding'] = 'gzip';
    }
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }

    if (url.pathname === '/api/trains') return json(req, res, { serverTime: Date.now(), trains: snapshot() });
    if (url.pathname === '/api/status') return json(req, res, status());
    if (url.pathname === '/api/train') {
      const id = url.searchParams.get('id') ?? '';
      const detail = describe?.(id) ?? sources.map((s) => s.describe(id)).find(Boolean);
      return detail ? json(req, res, { ...detail, serverTime: Date.now() }) : json(req, res, { error: 'unknown train' }, 404);
    }
    if (url.pathname === '/api/path') {
      const coords = trackPath?.(url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? '', url.searchParams.get('line') || undefined);
      // Not HTTP-cached: rebuilding the track data changes the answer. The
      // server and the page both cache paths in memory.
      return coords ? json(req, res, { coords }) : json(req, res, { error: 'unknown location' }, 404);
    }
    if (url.pathname === '/api/paths') {
      // Many sections in one request ("from>to" or "from>to@line", comma
      // separated): a page opening onto hundreds of moving trains would
      // otherwise queue hundreds of requests.
      const paths: Record<string, unknown> = {};
      for (const item of (url.searchParams.get('q') ?? '').split(',').slice(0, MAX_PATHS_PER_REQUEST)) {
        const m = /^([^>@]+)>([^>@]+)(?:@(.+))?$/.exec(item);
        if (m) paths[item] = trackPath?.(m[1], m[2], m[3]) ?? null;
      }
      return json(req, res, { paths });
    }
    if (url.pathname === '/api/stream') {
      const gzip = acceptsGzip(req);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(gzip && { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }),
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      // Each event is flushed through gzip as soon as it is written.
      let out: Writable = res;
      if (gzip) {
        const z = createGzip({ flush: zlibConstants.Z_SYNC_FLUSH });
        z.pipe(res);
        out = z;
      }
      const client: StreamClient = { res, out };
      out.write('retry: 3000\n\n');
      send(client, 'snapshot', { trains: snapshot(), status: status(), serverTime: Date.now() });
      clients.add(client);
      req.on('close', () => {
        clients.delete(client);
        if (out !== res) out.destroy();
      });
      return;
    }

    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const file = path.resolve(root, `.${rel}`);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      let body = await readFile(file);
      const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';
      // no-cache: make browsers revalidate so a changed page or script is never stale.
      const headers: http.OutgoingHttpHeaders = { 'Content-Type': type, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
      if (/^(text|application\/json|image\/svg)/.test(type) && body.length >= GZIP_MIN_BYTES && acceptsGzip(req)) {
        body = gzipSync(body);
        headers['Content-Encoding'] = 'gzip';
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });

  const close = () => {
    clearInterval(pump);
    clearInterval(statusTimer);
    clearInterval(keepalive);
    feed.stop();
    for (const s of sources) s.stop();
    for (const client of clients) client.out.end();
    clients.clear();
    server.close();
  };

  return { server, close };
}
