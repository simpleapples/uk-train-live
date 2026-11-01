// Live TRUST movements from Network Rail Open Data (NROD).
// Register at https://publicdatafeeds.networkrail.co.uk and subscribe your
// account to the TRAIN_MVT_ALL_TOC feed before using this.

import { StompClient } from '../stomp/client.ts';
import type { TrustMessage } from '../trust/types.ts';
import type { EmitMessages, Feed, FeedStatus } from './feed.ts';

export interface NrodOptions {
  username: string;
  password: string;
  host?: string;
  port?: number;
  tls?: boolean;
  topic?: string;
}

export class NrodFeed implements Feed {
  readonly kind = 'nrod';
  #opts: NrodOptions;
  #client?: StompClient;
  #status: FeedStatus = { connected: false, detail: 'not started' };

  constructor(opts: NrodOptions) {
    this.#opts = opts;
  }

  start(emit: EmitMessages): void {
    const topic = this.#opts.topic ?? 'TRAIN_MVT_ALL_TOC';
    this.#client = new StompClient({
      host: this.#opts.host ?? 'publicdatafeeds.networkrail.co.uk',
      port: this.#opts.port ?? 61618,
      tls: this.#opts.tls,
      login: this.#opts.username,
      passcode: this.#opts.password,
      destinations: [`/topic/${topic}`],
      onMessage: (_destination, body) => {
        const receivedAt = Date.now();
        try {
          // Each STOMP message carries a JSON array of TRUST messages.
          const parsed: unknown = JSON.parse(body);
          const messages = (Array.isArray(parsed) ? parsed : [parsed]) as TrustMessage[];
          emit(messages, receivedAt);
        } catch (err) {
          console.warn(`[nrod] dropped unparseable message: ${(err as Error).message}`);
        }
      },
      onStatus: (connected, detail) => {
        this.#status = { connected, detail };
        console.log(`[nrod] ${detail}`);
      },
    });
    this.#client.connect();
  }

  stop(): void {
    this.#client?.close();
  }

  status(): FeedStatus {
    return this.#status;
  }
}
