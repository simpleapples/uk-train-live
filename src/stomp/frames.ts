// Minimal STOMP 1.2 framing: enough to talk to Network Rail's ActiveMQ broker
// without pulling in a client library.

export interface StompFrame {
  command: string;
  headers: Record<string, string>;
  body: string;
}

const NUL = 0x00;
const LF = 0x0a;
const CR = 0x0d;

function escapeHeader(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/:/g, '\\c');
}

function unescapeHeader(v: string): string {
  return v.replace(/\\(\\|r|n|c)/g, (_, c: string) => ({ '\\': '\\', r: '\r', n: '\n', c: ':' })[c]!);
}

export function encodeFrame(command: string, headers: Record<string, string> = {}, body = ''): Buffer {
  // CONNECT headers are sent unescaped for STOMP 1.0 broker compatibility.
  const esc = command === 'CONNECT' ? (v: string) => v : escapeHeader;
  let head = `${command}\n`;
  for (const [k, v] of Object.entries(headers)) head += `${esc(k)}:${esc(v)}\n`;
  if (body) head += `content-length:${Buffer.byteLength(body)}\n`;
  return Buffer.concat([Buffer.from(`${head}\n${body}`), Buffer.from([NUL])]);
}

/**
 * Accumulates socket chunks and yields complete frames. Heart-beat EOLs are
 * skipped. Throws on a malformed frame; the stream cannot be resynchronised,
 * so the caller should drop the connection.
 */
export class FrameParser {
  #buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): StompFrame[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const frames: StompFrame[] = [];
    for (;;) {
      let start = 0;
      while (start < this.#buf.length && (this.#buf[start] === LF || this.#buf[start] === CR)) start++;
      if (start) this.#buf = this.#buf.subarray(start);
      if (!this.#buf.length) break;

      const headerEnd = this.#findHeaderEnd();
      if (!headerEnd) break;
      const lines = this.#buf.subarray(0, headerEnd.at).toString('utf8').split(/\r?\n/);
      const command = lines[0];
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const key = unescapeHeader(line.slice(0, i));
        // Repeated headers: the first one wins (STOMP 1.2).
        if (!(key in headers)) headers[key] = unescapeHeader(line.slice(i + 1));
      }

      const bodyStart = headerEnd.at + headerEnd.len;
      let bodyEnd: number;
      const contentLength = headers['content-length'];
      if (contentLength !== undefined) {
        if (!/^\d+$/.test(contentLength)) throw new Error(`invalid content-length "${contentLength}"`);
        bodyEnd = bodyStart + Number(contentLength);
        if (this.#buf.length < bodyEnd + 1) break;
        if (this.#buf[bodyEnd] !== NUL) throw new Error('frame body does not end where content-length says');
      } else {
        bodyEnd = this.#buf.indexOf(NUL, bodyStart);
        if (bodyEnd < 0) break;
      }
      frames.push({ command, headers, body: this.#buf.subarray(bodyStart, bodyEnd).toString('utf8') });
      this.#buf = this.#buf.subarray(bodyEnd + 1);
    }
    return frames;
  }

  #findHeaderEnd(): { at: number; len: number } | null {
    const lf = this.#buf.indexOf('\n\n');
    const crlf = this.#buf.indexOf('\r\n\r\n');
    if (lf < 0 && crlf < 0) return null;
    if (crlf >= 0 && (lf < 0 || crlf < lf)) return { at: crlf, len: 4 };
    return { at: lf, len: 2 };
  }
}
