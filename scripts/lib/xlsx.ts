// Just enough of .xlsx to read a sheet's cells: the zip container (stored or
// deflated entries, no zip64) and the sheet and shared-string XML.

import { inflateRawSync } from 'node:zlib';

/** Zip entry name -> its bytes. */
function unzip(buf: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
  // End of central directory: the last 22+ bytes, signature 0x06054b50.
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (wanted(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const unescape = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+);/g, (_, e: string) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : e === 'amp' ? '&' : String.fromCodePoint(Number(e.slice(1))));

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

/** Every row of the named sheets, as arrays of cell text (numbers as written). */
export function readSheets(file: Buffer, names: string[]): Map<string, string[][]> {
  const meta = unzip(file, (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml');
  const rels = new Map([...meta.get('xl/_rels/workbook.xml.rels')!.toString('utf8').matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const paths = new Map<string, string>();
  for (const m of meta.get('xl/workbook.xml')!.toString('utf8').matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    if (names.includes(unescape(m[1]))) paths.set(unescape(m[1]), `xl/${rels.get(m[2])!.replace(/^\/?xl\//, '')}`);
  }
  const strings = [...(meta.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => unescape(m[1].replace(/<[^>]+>/g, '')));
  const sheets = unzip(file, (n) => [...paths.values()].includes(n));
  const out = new Map<string, string[][]>();
  for (const [name, path] of paths) {
    const rows: string[][] = [];
    for (const row of sheets.get(path)!.toString('utf8').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const v = /<v>([\s\S]*?)<\/v>/.exec(c[3] ?? '')?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[3] ?? '')?.[1] ?? '';
        cells[columnIndex(c[1])] = c[2].includes('t="s"') ? strings[Number(v)] : unescape(v);
      }
      rows.push(Array.from(cells, (v) => v ?? ''));
    }
    out.set(name, rows);
  }
  return out;
}
