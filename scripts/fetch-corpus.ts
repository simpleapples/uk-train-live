// Downloads Network Rail's CORPUS reference data and writes data/stanox.json
// (STANOX -> TIPLOCs + name), which live mode needs to place TRUST reports.
// Needs NROD_USERNAME / NROD_PASSWORD (environment or .env). The server also
// does this by itself when the file is missing.
import { writeFile, mkdir } from 'node:fs/promises';
import { fetchCorpus } from '../src/feeds/nrodFiles.ts';

try { process.loadEnvFile(); } catch { /* no .env file */ }

const OUT = new URL('../data/stanox.json', import.meta.url);

const { NROD_USERNAME, NROD_PASSWORD } = process.env;
if (!NROD_USERNAME || !NROD_PASSWORD) {
  console.error('Set NROD_USERNAME and NROD_PASSWORD (see .env.example).');
  process.exit(1);
}

const stanox = await fetchCorpus({ username: NROD_USERNAME, password: NROD_PASSWORD });
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify(stanox));
console.log(`Wrote ${Object.keys(stanox).length} STANOX codes to data/stanox.json`);
