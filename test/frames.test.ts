import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameParser } from '../src/stomp/frames.ts';

const frame = (s: string) => Buffer.from(s.replace(/\\0/g, '\0'));

describe('FrameParser', () => {
  it('parses a frame without content-length', () => {
    const p = new FrameParser();
    const [f] = p.push(frame('MESSAGE\ndestination:/topic/TRAIN_MVT_ALL_TOC\n\n[{"a":1}]\\0'));
    expect(f).toEqual({ command: 'MESSAGE', headers: { destination: '/topic/TRAIN_MVT_ALL_TOC' }, body: '[{"a":1}]' });
  });

  it('reassembles a frame split across chunks', () => {
    const p = new FrameParser();
    expect(p.push(frame('MESSAGE\ndestina'))).toEqual([]);
    expect(p.push(frame('tion:/topic/x\n\n{"par'))).toEqual([]);
    const [f] = p.push(frame('t":2}\\0'));
    expect(f.body).toBe('{"part":2}');
  });

  it('honours content-length for multi-byte bodies', () => {
    const body = '{"name":"Ynys Môn"}';
    const p = new FrameParser();
    const [f] = p.push(Buffer.concat([
      Buffer.from(`MESSAGE\ncontent-length:${Buffer.byteLength(body)}\n\n`),
      Buffer.from(body),
      Buffer.from([0]),
    ]));
    expect(f.body).toBe(body);
  });

  it('skips heart-beats and handles several frames per chunk', () => {
    const p = new FrameParser();
    const frames = p.push(frame('\n\nCONNECTED\nversion:1.2\n\n\\0\nMESSAGE\n\nhello\\0\n'));
    expect(frames.map((f) => f.command)).toEqual(['CONNECTED', 'MESSAGE']);
    expect(frames[1].body).toBe('hello');
  });

  it('accepts CRLF line endings and keeps the first repeated header', () => {
    const p = new FrameParser();
    const [f] = p.push(frame('ERROR\r\nmessage:first\r\nmessage:second\r\n\r\noops\\0'));
    expect(f.headers.message).toBe('first');
    expect(f.body).toBe('oops');
  });

  it('rejects a non-numeric content-length instead of looping forever', () => {
    const p = new FrameParser();
    expect(() => p.push(frame('MESSAGE\ncontent-length:abc\n\nhi\\0'))).toThrow(/content-length/);
  });

  it('rejects a body that does not end where content-length says', () => {
    const p = new FrameParser();
    expect(() => p.push(frame('MESSAGE\ncontent-length:2\n\nhello\\0'))).toThrow(/content-length/);
  });

  it('round-trips escaped header values', () => {
    const p = new FrameParser();
    const [f] = p.push(encodeFrame('SEND', { note: 'a:b\nc\\d' }, 'x'));
    expect(f.headers.note).toBe('a:b\nc\\d');
    expect(f.body).toBe('x');
  });
});
