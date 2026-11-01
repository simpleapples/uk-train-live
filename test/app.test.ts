import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { LocationIndex, type StationTable } from '../src/engine/locations.ts';
import { TrainStore } from '../src/engine/trainStore.ts';
import { DemoFeed } from '../src/feeds/demoFeed.ts';

const stations: StationTable = JSON.parse(readFileSync(new URL('../data/stations.json', import.meta.url), 'utf8'));

let app: ReturnType<typeof createApp>;
let base: string;

beforeAll(async () => {
  app = createApp({
    feed: new DemoFeed(stations),
    store: new TrainStore(LocationIndex.byKey(stations)),
    publicDir: fileURLToPath(new URL('../public', import.meta.url)),
    // Known places A, B, C; a TfL line's track bends.
    path: (from, to, line) => (['A', 'B', 'C'].includes(from) && ['A', 'B', 'C'].includes(to) ? [[0, 0], [1, line ? 2 : 1]] : null),
  });
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(() => app.close());

describe('HTTP server', () => {
  it('serves the map page', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('UK Live Trains');
  });

  it('returns a train snapshot', async () => {
    const body = (await (await fetch(`${base}/api/trains`)).json()) as { trains: object[] };
    expect(body.trains.length).toBeGreaterThan(100);
    expect(body.trains[0]).toHaveProperty('from.lat');
  });

  it('opens the SSE stream with a snapshot event', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('event: snapshot')) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    expect(text).toContain('event: snapshot');
  });

  it('compresses the snapshot for browsers that accept gzip', async () => {
    const res = await fetch(`${base}/api/trains`, { headers: { 'Accept-Encoding': 'gzip' } });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    // fetch undoes the gzip.
    expect(((await res.json()) as { trains: object[] }).trains.length).toBeGreaterThan(100);
  });

  it('answers many track paths in one request', async () => {
    const res = await fetch(`${base}/api/paths?q=${encodeURIComponent('A>B,B>C@central,A>X,nonsense')}`);
    expect(await res.json()).toEqual({ paths: { 'A>B': [[0, 0], [1, 1]], 'B>C@central': [[0, 0], [1, 2]], 'A>X': null } });
  });

  it('refuses paths outside the public folder', async () => {
    const res = await fetch(`${base}/..%2Fpackage.json`);
    expect([403, 404]).toContain(res.status);
  });
});
