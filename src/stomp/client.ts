// STOMP-over-TCP subscriber with heart-beats and reconnect-with-backoff.

import net from 'node:net';
import tls from 'node:tls';
import { encodeFrame, FrameParser } from './frames.ts';

export interface StompOptions {
  host: string;
  port: number;
  tls?: boolean;
  login: string;
  passcode: string;
  destinations: string[];
  heartbeatMs?: number;
  /**
   * Reconnect if nothing at all arrives for this long. The TRUST feed never
   * goes quiet, so silence means a dead connection even without heart-beats.
   */
  silenceMs?: number;
  onMessage: (destination: string, body: string) => void;
  onStatus?: (connected: boolean, detail: string) => void;
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
// A broker ERROR (bad login, feed not enabled for the account) will not fix
// itself in a second; never retry faster than this after one.
const ERROR_BACKOFF_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;

export class StompClient {
  #opts: StompOptions;
  #socket?: net.Socket;
  #parser = new FrameParser();
  #heartbeat?: NodeJS.Timeout;
  #watchdog?: NodeJS.Timeout;
  #handshake?: NodeJS.Timeout;
  #reconnect?: NodeJS.Timeout;
  #lastData = 0;
  #backoffMs = MIN_BACKOFF_MS;
  #lastError = '';
  #stopped = false;

  constructor(opts: StompOptions) {
    this.#opts = opts;
  }

  connect(): void {
    this.#stopped = false;
    const { host, port } = this.#opts;
    const socket = this.#opts.tls ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    socket.setKeepAlive(true, 30_000);
    this.#socket = socket;
    this.#parser = new FrameParser();
    this.#lastData = Date.now();
    this.#status(false, `connecting to ${host}:${port}`);
    this.#handshake = setTimeout(() => this.#fail('no CONNECTED reply from broker'), HANDSHAKE_TIMEOUT_MS);

    socket.once(this.#opts.tls ? 'secureConnect' : 'connect', () => {
      const hb = this.#opts.heartbeatMs ?? 15_000;
      socket.write(encodeFrame('CONNECT', {
        'accept-version': '1.2,1.1,1.0',
        host: '/',
        login: this.#opts.login,
        passcode: this.#opts.passcode,
        'heart-beat': `${hb},${hb}`,
      }));
    });
    socket.on('data', (chunk: Buffer) => {
      this.#lastData = Date.now();
      let frames;
      try {
        frames = this.#parser.push(chunk);
      } catch (err) {
        this.#fail(`malformed frame: ${(err as Error).message}`);
        return;
      }
      for (const frame of frames) this.#onFrame(frame.command, frame.headers, frame.body);
    });
    socket.on('error', (err) => {
      this.#lastError = `socket error: ${err.message}`;
      this.#status(false, this.#lastError);
    });
    socket.on('close', () => this.#scheduleReconnect());
  }

  close(): void {
    this.#stopped = true;
    clearTimeout(this.#reconnect);
    this.#clearTimers();
    if (this.#socket?.writable) this.#socket.end(encodeFrame('DISCONNECT'));
    this.#socket?.destroy();
  }

  #onFrame(command: string, headers: Record<string, string>, body: string): void {
    switch (command) {
      case 'CONNECTED': {
        clearTimeout(this.#handshake);
        this.#opts.destinations.forEach((destination, i) => {
          this.#socket?.write(encodeFrame('SUBSCRIBE', { id: String(i), destination, ack: 'auto' }));
        });
        this.#startTimers(headers['heart-beat']);
        this.#status(true, `connected; subscribing to ${this.#opts.destinations.join(', ')}`);
        break;
      }
      case 'MESSAGE':
        // Only a delivered message proves the login and subscription work;
        // resetting the backoff on CONNECTED would retry a rejected
        // SUBSCRIBE every second.
        if (this.#backoffMs !== MIN_BACKOFF_MS || this.#lastError) {
          this.#backoffMs = MIN_BACKOFF_MS;
          this.#lastError = '';
          this.#status(true, `receiving ${this.#opts.destinations.join(', ')}`);
        }
        this.#opts.onMessage(headers.destination ?? '', body);
        break;
      case 'ERROR':
        this.#backoffMs = Math.max(this.#backoffMs, ERROR_BACKOFF_MS);
        this.#fail(`broker error: ${headers.message ?? body.slice(0, 200)}`);
        break;
    }
  }

  #startTimers(serverHeartbeat = '0,0'): void {
    this.#clearTimers();
    const ours = this.#opts.heartbeatMs ?? 15_000;
    const [serverSends, serverWants] = serverHeartbeat.split(',').map(Number);
    if (serverWants > 0) {
      // Send well inside the negotiated interval to allow for event-loop jitter.
      const every = Math.max(ours, serverWants) / 2;
      this.#heartbeat = setInterval(() => this.#socket?.write('\n'), every);
    }
    const heartbeatLimit = serverSends > 0 ? Math.max(ours, serverSends) * 3 : Infinity;
    const limit = Math.min(heartbeatLimit, this.#opts.silenceMs ?? 120_000);
    this.#watchdog = setInterval(() => {
      if (Date.now() - this.#lastData > limit) this.#fail(`no data for ${Math.round(limit / 1000)}s`);
    }, Math.min(limit, 10_000));
  }

  #fail(reason: string): void {
    this.#lastError = reason;
    this.#status(false, reason);
    this.#socket?.destroy();
  }

  #scheduleReconnect(): void {
    this.#clearTimers();
    if (this.#stopped) return;
    const wait = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);
    const why = this.#lastError ? ` (${this.#lastError})` : '';
    this.#status(false, `disconnected${why}; retrying in ${Math.round(wait / 1000)}s`);
    this.#reconnect = setTimeout(() => this.connect(), wait);
  }

  #clearTimers(): void {
    clearTimeout(this.#handshake);
    clearInterval(this.#heartbeat);
    clearInterval(this.#watchdog);
  }

  #status(connected: boolean, detail: string): void {
    this.#opts.onStatus?.(connected, detail);
  }
}
