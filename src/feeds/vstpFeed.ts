// Very short term plans (VSTP) from Network Rail Open Data: schedules made
// within 48 hours of running (engineering trains, extra freight, short-notice
// changes), which the daily timetable extract does not have. Subscribe your
// account to the VSTP feed as well as TRAIN_MVT_ALL_TOC.
//
// A connection of its own: a broker that refuses this topic must not take the
// train movements down with it.

import { StompClient } from '../stomp/client.ts';
import type { VstpSchedule } from '../schedule/timetable.ts';
import type { FeedStatus } from './feed.ts';
import type { NrodOptions } from './nrodFeed.ts';

export class VstpFeed {
  #opts: NrodOptions;
  #client?: StompClient;
  #status: FeedStatus = { connected: false, detail: 'not started' };

  constructor(opts: NrodOptions) {
    this.#opts = opts;
  }

  start(onSchedule: (schedule: VstpSchedule) => void): void {
    this.#client = new StompClient({
      host: this.#opts.host ?? 'publicdatafeeds.networkrail.co.uk',
      port: this.#opts.port ?? 61618,
      tls: this.#opts.tls,
      login: this.#opts.username,
      passcode: this.#opts.password,
      destinations: ['/topic/VSTP_ALL'],
      onMessage: (_destination, body) => {
        try {
          const schedule = (JSON.parse(body) as { VSTPCIFMsgV1?: { schedule?: VstpSchedule } }).VSTPCIFMsgV1?.schedule;
          if (schedule?.CIF_train_uid) onSchedule(schedule);
        } catch (err) {
          console.warn(`[vstp] dropped unparseable message: ${(err as Error).message}`);
        }
      },
      onStatus: (connected, detail) => {
        this.#status = { connected, detail };
        console.log(`[vstp] ${detail}`);
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
