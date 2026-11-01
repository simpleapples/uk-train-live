// Browser side: keeps a copy of every train's current segment (pushed over
// SSE) and animates each one along the track between its timing points.

const FRAME_MS = 250;
const RAIL_ATTRIBUTION = 'Contains information of Network Rail Infrastructure Limited licensed under the Network Rail data feeds licence. Stations: NaPTAN (OGL).';
// Great Britain's railway, for the opening view.
const GB_BOUNDS = [[-6.3, 50.0], [1.8, 58.6]];
const DELAY_COLORS = { ontime: '#1a9e6f', minor: '#e8a317', major: '#d9412b' };
// National Rail plus TfL's networks; each can be switched on and off.
const NETWORKS = ['rail', 'tube', 'overground', 'elizabeth-line', 'dlr'];
const NET_LABELS = { rail: 'Rail', tube: 'Tube', overground: 'Overground', 'elizabeth-line': 'Elizabeth', dlr: 'DLR' };
const NET_COLORS = { rail: '#1a9e6f', tube: '#E32017', overground: '#EE7C0E', 'elizabeth-line': '#6950A1', dlr: '#00A4A7' };

const trains = new Map();
const paths = new Map(); // "line|from>to" -> { coords, cum } once loaded, null while loading or unavailable
// Which way each train last faced, kept while it stands at a station.
const headings = new Map();
let clockOffset = 0; // server clock minus browser clock
let selectedId = null;
let detail = null; // /api/train response for the selected train
let detailStamp = null; // which train state `detail` was fetched for
let pendingFit = false; // zoom to the selected train's route when its detail arrives
let following = false; // keep the selected train centred
let lastStatus = null;
let streamOk = false; // false while the SSE connection to our server is down
let shown = new Set(NETWORKS);
// Lines ("tfl:central") and operators ("rail:LNER") switched off.
let hiddenLines = new Set();
let linesOpen = false; // the per-line picker under the network chips
let railLines = true; // railway lines overlay

const $ = (id) => document.getElementById(id);
const panel = $('panel');
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const hhmm = (ms) => (ms ? timeFmt.format(ms) : '');
const serverNow = () => Date.now() + clockOffset;
const isNarrow = () => window.innerWidth <= 640;

// Only touch the DOM when an element's markup really changed (keeps open
// <details>, focus and scroll positions).
const drawn = new Map();
function setHtml(el, html) {
  if (drawn.get(el) === html) return false;
  drawn.set(el, html);
  el.innerHTML = html;
  return true;
}

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  bounds: GB_BOUNDS,
  fitBoundsOptions: { padding: mapPadding() },
  minZoom: 4,
  maxBounds: [[-14, 48.5], [6, 61.5]],
  // Added below, with the data sources' credits.
  attributionControl: false,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

/** Map padding that keeps routes and trains out from under the panel. */
function mapPadding() {
  if (isNarrow()) return { top: 50, right: 20, left: 20, bottom: panel.offsetHeight + 20 };
  return { top: 40, right: 60, bottom: 40, left: panel.offsetWidth + 40 };
}

// ---- Train helpers ----

// National Rail trains, freight included, are coloured by lateness.
function category(t) {
  if (t.mode) return 'tfl';
  if (t.delayMin >= 5) return 'major';
  if (t.delayMin >= 1) return 'minor';
  return 'ontime';
}

const colorOf = (t) => t.color ?? DELAY_COLORS[category(t)];

// Lines and operators are shown as colour badges with short codes: compact,
// and no logos (the Network Rail data licence bars operator logos, and TfL's
// roundel is a registered trade mark).
const TFL_LINES = {
  tube: { bakerloo: 'BAK', central: 'CEN', circle: 'CIR', district: 'DIS', 'hammersmith-city': 'H&C', jubilee: 'JUB', metropolitan: 'MET', northern: 'NOR', piccadilly: 'PIC', victoria: 'VIC', 'waterloo-city': 'W&C' },
  overground: { liberty: 'LIB', lioness: 'LIO', mildmay: 'MIL', suffragette: 'SUF', weaver: 'WEA', windrush: 'WIN' },
  'elizabeth-line': { elizabeth: 'EL' },
  dlr: { dlr: 'DLR' },
};
const TFL_COLORS = {
  bakerloo: '#B36305', central: '#E32017', circle: '#FFD300', district: '#00782A', 'hammersmith-city': '#F3A9BB', jubilee: '#A0A5A9',
  metropolitan: '#9B0056', northern: '#000000', piccadilly: '#003688', victoria: '#0098D4', 'waterloo-city': '#95CDBA',
  liberty: '#61686B', lioness: '#FAA61A', mildmay: '#006FE6', suffragette: '#18A95D', weaver: '#893B67', windrush: '#DC241F',
  elizabeth: '#6950A1', dlr: '#00A4A7',
};
const TFL_LINE_NAMES = {
  'hammersmith-city': 'Hammersmith & City', 'waterloo-city': 'Waterloo & City', elizabeth: 'Elizabeth line', dlr: 'DLR',
};
const lineName = (line) => TFL_LINE_NAMES[line] ?? `${line[0].toUpperCase()}${line.slice(1)}`;
// Train operators by name, with a short code and a colour for the badge.
const OPERATOR_BADGES = {
  LNER: ['LNER', '#CE0E2D'], 'Great Northern': ['GN', '#5C2D91'], 'Avanti West Coast': ['AWC', '#004354'], GWR: ['GWR', '#0A493E'],
  'East Midlands Railway': ['EMR', '#4C2A85'], Southeastern: ['SE', '#00AFE8'], 'Greater Anglia': ['GA', '#D70428'], Southern: ['SN', '#5D8A2C'],
  'South Western Railway': ['SWR', '#24398C'], 'TransPennine Express': ['TPE', '#09A4EC'], Northern: ['NT', '#262262'], CrossCountry: ['XC', '#660F21'],
  'Transport for Wales': ['TfW', '#C8102E'], ScotRail: ['SR', '#1E467D'], Freightliner: ['FL', '#B26E00'], 'DB Cargo': ['DB', '#EC0016'],
  // Live feed. Govia Thameslink is what TRUST says when the schedule (which
  // tells Thameslink, Southern, Great Northern and Gatwick Express apart) is not known.
  Thameslink: ['TL', '#E9438D'], 'Gatwick Express': ['GX', '#D6001C'], 'Govia Thameslink Railway': ['GTR', '#D5017A'],
  'West Midlands Trains': ['WMT', '#E07709'], 'Chiltern Railways': ['CH', '#1B9AD6'], c2c: ['c2c', '#B7007C'], Merseyrail: ['ME', '#FFCD00'],
  'Hull Trains': ['HT', '#DE005C'], 'Grand Central': ['GC', '#333333'], Lumo: ['LUMO', '#2B6CB0'], 'Caledonian Sleeper': ['CS', '#1F3A4D'],
  'Heathrow Express': ['HX', '#532E63'], 'Tyne and Wear Metro': ['TWM', '#FDB813'], Supertram: ['ST', '#0F4C81'], Eurostar: ['ES', '#F4C300'],
  'GB Railfreight': ['GBRf', '#F37021'], 'Direct Rail Services': ['DRS', '#0B3D91'], 'Colas Rail': ['COL', '#E8B400'],
  'Rail Operations Group': ['ROG', '#3E3E3E'], 'Balfour Beatty Rail': ['BBR', '#00467F'], 'Network Rail': ['NR', '#F5A100'],
  'West Coast Railways': ['WCR', '#7A1E2B'], 'Island Line': ['IL', '#2A7AB0'], 'North Yorkshire Moors Railway': ['NYMR', '#2F4F4F'],
  'Locomotive Services': ['LSL', '#4A4A4A'],
  // Shown as rail only when the TfL feed is off.
  'London Overground': ['LO', '#EE7C0E'], 'Elizabeth line': ['EL', '#6950A1'], 'Bakerloo line': ['BAK', '#B36305'], 'District line': ['DIS', '#00782A'],
};

/** A code for an operator without a badge of its own: its initials ("Serco Rail Operations" -> SRO). */
function initials(name) {
  const words = name.split(/[\s&-]+/).filter((w) => w && !/^(and|of|the)$/i.test(w));
  return words.length > 1 ? words.slice(0, 4).map((w) => w[0].toUpperCase()).join('') : name.slice(0, 4).toUpperCase();
}

const netOfLine = (line) => NETWORKS.find((n) => TFL_LINES[n]?.[line]);
const tflBadge = (line) => ({ key: `tfl:${line}`, code: TFL_LINES[netOfLine(line)]?.[line] ?? line, color: TFL_COLORS[line] ?? '#475467', name: lineName(line) });

/** The line (TfL) or operator (National Rail) a train belongs to, as a badge. */
function badgeOf(t) {
  if (t.mode) return { ...tflBadge(t.line), color: t.color ?? TFL_COLORS[t.line], name: t.operator };
  const name = t.operator ?? `Operator ${t.toc || '?'}`;
  const [code, color] = OPERATOR_BADGES[name] ?? [t.operator ? initials(t.operator) : t.toc || '?', '#475467'];
  return { key: `rail:${name}`, code, color, name };
}

/** Dark text on light colours (Circle, H&C, Waterloo & City, Lioness, amber). */
const inks = new Map();
function textOn(hex) {
  let ink = inks.get(hex);
  if (!ink) {
    const n = parseInt(hex.slice(1), 16);
    const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    ink = lum > 0.62 ? '#101828' : '#ffffff';
    inks.set(hex, ink);
  }
  return ink;
}

function badgeHtml(b, size = '') {
  return `<span class="lb${size ? ` ${size}` : ''}" style="background:${escapeHtml(b.color)};color:${textOn(b.color)}" title="${escapeHtml(b.name)}">${escapeHtml(b.code)}</span>`;
}

/** Whether the train's network, and its line or operator, are switched on. */
const visible = (t) => shown.has(t.mode ?? 'rail') && !hiddenLines.has(badgeOf(t).key);

/** TfL's current disruption on a line, if any. */
const lineStatusOf = (line) => lastStatus?.sources?.tfl?.lines?.[line];

// Equirectangular metres are accurate enough over a few kilometres of track.
function metres(a, b) {
  const kx = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180) * 111320;
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110574);
}

/** Compass bearing from a to b in degrees, or null if they are the same point. */
function bearingOf(a, b) {
  const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  const dy = b[1] - a[1];
  if (!dx && !dy) return null;
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
}

// Sections still to fetch: request item ("from>to" or "from>to@line") -> cache key.
const pathQueue = new Map();
let pathTimer = null;
const PATHS_PER_REQUEST = 100;

/** Track between two places; TfL trains use their own line's track. Null until it has loaded. */
function trackPath(from, to, line) {
  const key = `${line ?? ''}|${from}>${to}`;
  if (paths.has(key)) return paths.get(key);
  paths.set(key, null);
  pathQueue.set(line ? `${from}>${to}@${line}` : `${from}>${to}`, key);
  // Collect a frame's worth of sections into one request.
  pathTimer ??= setTimeout(fetchPaths, 30);
  return null;
}

function fetchPaths() {
  pathTimer = null;
  const items = [...pathQueue];
  pathQueue.clear();
  for (let i = 0; i < items.length; i += PATHS_PER_REQUEST) {
    const batch = items.slice(i, i + PATHS_PER_REQUEST);
    // no-store: earlier builds sent cacheable responses, possibly straight lines.
    fetch(`/api/paths?q=${encodeURIComponent(batch.map(([item]) => item).join(','))}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        for (const [item, key] of batch) {
          const coords = d.paths?.[item];
          if (!coords || coords.length < 2) continue;
          const cum = [0];
          for (let j = 1; j < coords.length; j++) cum.push(cum[j - 1] + metres(coords[j - 1], coords[j]));
          paths.set(key, { coords, cum });
        }
      })
      // Ask again next time these sections are needed.
      .catch(() => { for (const [, key] of batch) paths.delete(key); });
  }
}

/** The point a fraction f along a path, and the direction of travel there. */
function along(path, f) {
  const target = f * path.cum[path.cum.length - 1];
  let lo = 1;
  let hi = path.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (path.cum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const a = path.coords[lo - 1];
  const b = path.coords[lo];
  const span = path.cum[lo] - path.cum[lo - 1];
  const t = span ? (target - path.cum[lo - 1]) / span : 0;
  return { pos: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing: bearingOf(a, b) };
}

const progressOf = (t, now) => Math.min(1, Math.max(0, (now - t.departedAt) / t.runMs));

/** Where a train is now, and which way it faces (null until it has moved). */
function locate(t, now) {
  if (t.state !== 'moving' || !t.to) {
    let bearing = headings.get(t.id) ?? null;
    // Not seen moving yet: face along the track to where it goes next.
    if (bearing === null && t.state === 'stopped' && t.toward) {
      const path = trackPath(t.from.key, t.toward, t.line);
      if (path) bearing = along(path, 0).bearing;
    }
    return { pos: [t.from.lon, t.from.lat], bearing };
  }
  const f = progressOf(t, now);
  const path = trackPath(t.from.key, t.to.key, t.line);
  const here = path
    ? along(path, f)
    : {
      pos: [t.from.lon + (t.to.lon - t.from.lon) * f, t.from.lat + (t.to.lat - t.from.lat) * f],
      bearing: bearingOf([t.from.lon, t.from.lat], [t.to.lon, t.to.lat]),
    };
  if (here.bearing === null) here.bearing = headings.get(t.id) ?? null;
  else headings.set(t.id, here.bearing);
  return here;
}

const positionOf = (t, now) => locate(t, now).pos;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function delayLabel(t) {
  if (t.delayMin > 0) return `+${t.delayMin} min`;
  if (t.freight) return '';
  if (t.delayMin < 0) return `${-t.delayMin} min early`;
  return 'On time';
}

/** Short text name (search sorting, plain-text contexts). */
function nameOf(t) {
  if (t.mode) return t.destination ? `${t.operator} → ${t.destination}` : t.operator;
  return [t.headcode, t.operator].filter(Boolean).join(' · ');
}

/** Badge plus the shortest useful text: headcode (rail) and destination. */
function shortHtml(t) {
  const to = t.destination ? `→ ${t.destination}` : '';
  const text = t.mode ? to : [t.headcode, to].filter(Boolean).join(' ');
  return `${badgeHtml(badgeOf(t))}<span class="short-text">${escapeHtml(text)}</span>`;
}

/** Title row: badge, then headcode and delay for rail, line name for TfL. */
function titleHtml(t) {
  const badge = badgeHtml(badgeOf(t), 'lg');
  if (t.mode) return `${badge}<span class="hc">${escapeHtml(t.operator)}</span>`;
  const delay = delayLabel(t);
  return `${badge}<span class="hc">${escapeHtml(t.headcode)}</span>${delay ? `<span class="badge ${category(t)}">${delay}</span>` : ''}`;
}

// ---- Train type: a side view of the kind of train, its class, and facility icons ----

const WHITE = 'fill="#fff" fill-opacity=".85"';
const wheels = (xs) => xs.map((x) => `<circle cx="${x}" cy="21.5" r="2" fill="#1d2330"/>`).join('');
const pantograph = (x) => `<path d="M${x} 7l5-4.5 5 4.5M${x + 2} 2.5h6" fill="none" stroke="#1d2330" stroke-width="1.2" stroke-linejoin="round"/>`;
const coach = (x, w) => `<rect x="${x}" y="7" width="${w}" height="12" rx="2"/><rect x="${x + 4}" y="10" width="${w - 8}" height="3.2" rx="1" ${WHITE}/>`;

/** Front to the right; drawn in the operator's colour. 112 x 26. */
function trainArt(s, freight) {
  const electric = s.traction === 'electric' && !s.thirdRail;
  if (s.kind === 'loco') {
    const loco = `<path d="M66 6h37a3 3 0 0 1 3 3v10H66z"/><rect x="101.5" y="8.5" width="3" height="4" rx=".8" ${WHITE}/>`
      + `<rect x="67.5" y="8.5" width="3" height="4" rx=".8" ${WHITE}/><rect x="74" y="9" width="22" height="2" rx="1" fill="#fff" fill-opacity=".3"/>`
      + wheels([71, 77, 95, 101]) + (electric ? pantograph(80) : '');
    const hauled = freight
      ? [2, 34].map((x) => `<rect x="${x}" y="16" width="29" height="3" fill="#475467"/><rect x="${x + 2}" y="9" width="25" height="7" rx="1" fill="#98a2b3"/>`).join('') + wheels([7, 26, 39, 58])
      : coach(2, 29) + coach(34, 29) + wheels([7, 26, 39, 58]);
    return hauled + loco;
  }
  if (s.kind === 'tube') {
    // Deep-level Tube trains: the round-topped profile of the tunnels they run in.
    return `<path d="M2 19v-6.5C2 9.5 5 7 9 7h36c4 0 7 2.5 7 5.5V19z"/><rect x="7" y="10" width="40" height="3.2" rx="1" ${WHITE}/>`
      + `<path d="M55 19v-6.5c0-3 3-5.5 7-5.5h38c3.5 0 6 2.8 6 6v6z"/><rect x="60" y="10" width="37" height="3.2" rx="1" ${WHITE}/><rect x="101.5" y="9.5" width="3" height="4" rx=".8" ${WHITE}/>`
      + wheels([9, 15, 39, 45, 62, 68, 92, 98]);
  }
  const lead = s.kind === 'high-speed'
    ? `<path d="M55 7h33c8 0 15 4 20 10v2H55z"/><rect x="59" y="10" width="27" height="3.2" rx="1" ${WHITE}/><path d="M92 9.2c4.3.9 8 3.2 10.6 6.3H96z" ${WHITE}/>`
    : `<path d="M55 7h47a4 4 0 0 1 4 4v8H55z"/><rect x="59" y="10" width="38" height="3.2" rx="1" ${WHITE}/><rect x="101.5" y="9.5" width="3" height="4" rx=".8" ${WHITE}/>`;
  const roof = electric ? pantograph(68) : s.traction === 'diesel' && s.kind !== 'high-speed' ? '<rect x="74" y="5" width="4" height="2" rx=".5"/>' : '';
  return coach(2, 50) + lead + roof + wheels([9, 15, 39, 45, 62, 68, 92, 98]);
}

// Facility icons, 16 x 16, stroked.
const FACILITY_ICONS = {
  cup: 'M3 6h8v3.5A3.5 3.5 0 0 1 7.5 13h-1A3.5 3.5 0 0 1 3 9.5zM11 7.5h1a1.75 1.75 0 0 1 0 3.5h-1.2M5.5 2.5V4M8.5 2.5V4',
  cutlery: 'M4.5 2v4a1.5 1.5 0 0 0 3 0V2M6 6v8M11.5 14V2c-1.7 1-2.5 3-2.5 5.5 0 1 .5 1.5 1.5 1.5h1',
  bed: 'M1.5 12.5V4M1.5 9.5h13v3M14.5 9.5v-1a2 2 0 0 0-2-2H7v3M4.25 6.25a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5',
  ticket: 'M2 4h12v2.5a1.5 1.5 0 0 0 0 3V12H2V9.5a1.5 1.5 0 0 0 0-3zM9.5 4.5v1.5M9.5 7.25v1.5M9.5 10v1.5',
  snow: 'M8 1.5v13M2.4 4.75l11.2 6.5M2.4 11.25l11.2-6.5M6.2 2.6 8 4l1.8-1.4M6.2 13.4 8 12l1.8 1.4',
  bike: 'M4 13.25a2.75 2.75 0 1 1 0-5.5 2.75 2.75 0 0 1 0 5.5M12 13.25a2.75 2.75 0 1 1 0-5.5 2.75 2.75 0 0 1 0 5.5M4 10.5 6.5 6h4.5l1 4.5M6.5 6l2 4.5L11 6M5.5 4.5h2',
};
const ICON_OF = { buffet: 'cup', trolley: 'cup', 'hot-food': 'cup', restaurant: 'cutlery', meal: 'cutlery', sleeper: 'bed', reservations: 'ticket', bike: 'bike', 'air-con': 'snow' };

function facilitiesHtml(features) {
  const icons = new Map(); // icon -> labels, so a buffet and a trolley share one cup
  let first = '';
  for (const f of features) {
    if (f.id === 'first') first = '<span class="fac-first" title="First class">1st</span>';
    else if (ICON_OF[f.id]) icons.set(ICON_OF[f.id], [...(icons.get(ICON_OF[f.id]) ?? []), f.label]);
  }
  return first + [...icons].map(([icon, labels]) => {
    const label = escapeHtml(labels.join(', '));
    return `<span class="fac" role="img" aria-label="${label}" title="${label}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="${FACILITY_ICONS[icon]}"/></svg></span>`;
  }).join('');
}

/** The train-type card: side view, class, top speed (or load) and facilities. */
function stockHtml(t, s) {
  if (!s) return '';
  const art = s.kind ? `<svg class="stock-art" viewBox="0 0 112 26" style="color:${escapeHtml(badgeOf(t).color)}" aria-hidden="true"><g fill="currentColor">${trainArt(s, t.freight)}</g></svg>` : '';
  const facts = [s.maxMph && `${s.maxMph} mph`, s.tonnes && `${s.tonnes.toLocaleString('en-GB')} t`].filter(Boolean).map((f) => `<span>${f}</span>`).join('');
  return `${art}<div class="stock-text"><div class="stock-name">${escapeHtml(s.stock ?? '')}</div><div class="stock-sub">${facts}${facilitiesHtml(s.features)}</div></div>`;
}

function detailFor(t) {
  return detail?.train.id === t.id ? detail : null;
}

/** "Origin → Destination" when the whole route is known. */
function routeLabel(t) {
  // Rail: first and last passenger stops, from the train's schedule.
  if (t.origin && t.destination) return t.origin === t.destination ? `Round trip from ${t.origin}` : `${t.origin} → ${t.destination}`;
  const d = detailFor(t);
  if (!d?.stops.length) return t.destination ? `To ${t.destination}` : '';
  if (!d.timetabled) return `From ${d.stops[0].name}`;
  return `${d.stops[0].name} → ${d.stops[d.stops.length - 1].name}`;
}

/** Where the train is, in a few words (search results and hover labels). */
function whereLabel(t) {
  const d = detailFor(t);
  if (t.state === 'terminated') return `Terminated at ${t.from.name}`;
  if (t.state === 'stopped') return `At ${t.from.name}`;
  return `${d?.previous?.name ?? t.from.name} – ${d?.next?.name ?? t.to.name}`;
}

/** Operator (when the badge is only a code), platform, and report age once it is old. */
function metaLabel(t, now) {
  const parts = [];
  const b = badgeOf(t);
  if (!t.mode && b.name !== b.code) parts.push(b.name);
  if (t.platform) parts.push(t.mode ? t.platform : `Platform ${t.platform}`);
  if (now - t.reportedAt > 3 * 60_000) parts.push(`reported ${ago(now - t.reportedAt)}`);
  return parts.join(' · ');
}

/** A line disruption that opens to show TfL's explanation. */
function disruptionHtml(line, s, withBadge) {
  const badge = withBadge ? badgeHtml(tflBadge(line)) : '';
  const reason = s.reason ? `<p>${escapeHtml(s.reason)}</p>` : '';
  return `<details class="disruption${s.closed ? ' closed' : ''}"><summary>${badge}<span>${escapeHtml(s.summary)}</span></summary>${reason}</details>`;
}

// ---- Selection: route highlight and detail panel ----

function select(id) {
  const t = trains.get(id);
  if (!t) return;
  hideResults();
  selectedId = id;
  detail = null;
  detailStamp = null;
  // Zoom to the whole route once its detail arrives, even if a newer request
  // for the same train replaces the first one.
  pendingFit = true;
  setFollow(false);
  setRoute(null);
  $('d-calls').replaceChildren();
  setHtml($('d-note'), '');
  setHtml($('d-stock'), '');
  renderDetailHead(t);
  $('browse').hidden = true;
  $('detail').hidden = false;
  panel.classList.add('has-detail');
  panel.querySelector('.panel-body').scrollTop = 0;
  setFocusStyle();
  loadDetail(id, { scroll: true });
  render();
}

function clearSelection() {
  selectedId = null;
  detail = null;
  detailStamp = null;
  pendingFit = false;
  setFollow(false);
  setRoute(null);
  $('detail').hidden = true;
  $('browse').hidden = false;
  panel.classList.remove('has-detail');
  setFocusStyle();
}

/** While a train is selected, fade everything else so its route stands out. */
function setFocusStyle() {
  if (!map.getLayer('trains')) return;
  const focused = Boolean(selectedId);
  const dim = (v) => (focused ? ['case', ['==', ['get', 'selected'], true], 1, v] : 1);
  map.setPaintProperty('trains', 'icon-opacity', dim(0.25));
  map.setPaintProperty('train-labels', 'text-opacity', dim(0));
  map.setPaintProperty('openrailwaymap', 'raster-opacity', focused ? 0.2 : 0.45);
}

function setFollow(on) {
  following = on;
  $('d-follow').setAttribute('aria-pressed', String(on));
  const t = on && selectedId && trains.get(selectedId);
  if (t) map.easeTo({ center: positionOf(t, serverNow()), zoom: Math.max(map.getZoom(), 11), padding: mapPadding(), duration: 600 });
}

const stampOf = (t) => `${t.id}|${t.from.key}|${t.state}`;

async function loadDetail(id, { scroll = false } = {}) {
  const t = trains.get(id);
  if (!t) return;
  const stamp = stampOf(t);
  detailStamp = stamp;
  let d;
  try {
    const r = await fetch(`/api/train?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!r.ok) return;
    d = await r.json();
  } catch {
    return;
  }
  if (selectedId !== id || detailStamp !== stamp) return;
  setClock(d.serverTime);
  detail = d;
  setRoute(d);
  renderDetail(d, scroll);
  if (pendingFit) {
    pendingFit = false;
    fitRoute();
  }
}

/** Stations on the selected route; the line itself is drawn by drawRouteLine. */
function setRoute(d) {
  const source = map.getSource('route');
  if (!source) return;
  const features = [];
  for (const s of d?.stops ?? []) {
    if (!s.call || s.lat === undefined) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { name: s.name, status: s.status, color: d.train.color ?? '#2856d6' },
    });
  }
  source.setData({ type: 'FeatureCollection', features });
  drawRouteLine(serverNow());
}

/**
 * The first `dist` metres of a line, and the rest. Both share the cut point.
 */
function splitLine(coords, dist) {
  let done = 0;
  for (let i = 1; i < coords.length; i++) {
    const step = metres(coords[i - 1], coords[i]);
    if (done + step >= dist) {
      const f = step ? (dist - done) / step : 0;
      const a = coords[i - 1];
      const b = coords[i];
      const cut = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      return [[...coords.slice(0, i), cut], [cut, ...coords.slice(i)]];
    }
    done += step;
  }
  return [coords, coords.slice(-1)];
}

/**
 * The selected train's route in its colour: covered track pale, the rest
 * solid, split where the train is now rather than at its last station.
 */
function drawRouteLine(now) {
  const source = map.getSource('route-line');
  if (!source) return;
  const t = selectedId && trains.get(selectedId);
  const d = t && detailFor(t);
  if (!d) {
    source.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  let behind = d.pathBehind;
  let ahead = d.pathAhead;
  // The path ahead starts with the section the train is on, along the same
  // track the train is drawn on; cut it at the train.
  const section = t.state === 'moving' && t.to ? trackPath(t.from.key, t.to.key, t.line) : null;
  if (section && ahead.length > 1 && metres(section.coords[0], ahead[0]) < 50) {
    const [covered, rest] = splitLine(ahead, progressOf(t, now) * section.cum[section.cum.length - 1]);
    behind = behind.length ? [...behind, ...covered.slice(1)] : covered;
    ahead = rest;
  }
  const color = d.train.color ?? '#2856d6';
  const features = [];
  if (behind.length > 1) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: behind }, properties: { part: 'behind', color } });
  if (ahead.length > 1) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: ahead }, properties: { part: 'ahead', color } });
  source.setData({ type: 'FeatureCollection', features });
}

function fitRoute() {
  if (!detail) return;
  const coords = [...detail.pathBehind, ...detail.pathAhead];
  if (coords.length < 2) return;
  setFollow(false);
  const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  map.fitBounds(bounds, { padding: mapPadding(), maxZoom: 12, duration: 800 });
}

function renderDetailHead(t) {
  $('d-title').innerHTML = titleHtml(t);
  $('d-route').textContent = routeLabel(t);
}

// ---- Callout: the selected train's speed and next stop, beside it on the map ----

const callout = document.createElement('div');
callout.className = 'callout';
let calloutMarker = null;

// No public feed gives real speeds (no GPS), so the figure is an average over
// the section; the tooltip says how it was worked out.
function speedOf(t) {
  if (t.state !== 'moving') return null;
  const measured = t.measuredKmh ? `Measured ${t.measuredKmh} km/h over ${t.measuredSection}, from actual report times.` : '';
  if (t.speedKmh) {
    const how = t.mode ? 'Average over this section, from TfL arrival predictions.' : 'Average over this section, from its scheduled running time.';
    return { text: `≈ ${t.speedKmh} km/h`, tip: `${how} ${measured}`.trim() };
  }
  return t.measuredKmh ? { text: `${t.measuredKmh} km/h`, tip: measured } : null;
}

const LOAD_COLORS = ['#1a9e6f', '#86b41f', '#f79009', '#d9412b'];

/** How busy the train usually is here: four bars, then the word and a head count. */
function loadHtml(load) {
  if (!load) return '';
  const bars = [0, 1, 2, 3].map((i) => `<s style="height:${4 + i * 2}px${i <= load.level ? `;background:${LOAD_COLORS[load.level]}` : ''}"></s>`).join('');
  const tip = escapeHtml(`About ${load.people} people on board. ${load.basis}.`);
  return `<span class="co-load" title="${tip}"><em class="meter">${bars}</em>${load.label} · ~${load.people.toLocaleString('en-GB')} people</span>`;
}

function calloutHtml(t, d, now) {
  if (t.state === 'terminated') return `<b>Terminated</b><span>${escapeHtml(t.from.name)}</span>`;
  if (t.state === 'stopped') return `<b>Standing</b><span>${escapeHtml((d?.current ?? d?.previous)?.name ?? t.from.name)}</span>${loadHtml(d?.load)}`;
  const tfl = Boolean(t.mode);
  const speed = speedOf(t);
  const next = d?.next?.name ?? t.to?.name;
  const exp = d?.next && expectedOf(d.next, t.delayMin);
  const when = exp ? (tfl ? `${minutesUntil(exp, now)} min` : hhmm(exp)) : '';
  return (speed ? `<b title="${escapeHtml(speed.tip)}">${speed.text}</b>` : '')
    + (next ? `<span>→ ${escapeHtml(next)}${when ? ` <i${!tfl && t.delayMin > 0 ? ' class="late"' : ''}>${when}</i>` : ''}</span>` : '')
    + loadHtml(d?.load);
}

function renderCallout(t, now) {
  if (!t || !visible(t)) {
    calloutMarker?.remove();
    calloutMarker = null;
    return;
  }
  const pos = positionOf(t, now);
  if (!calloutMarker) calloutMarker = new maplibregl.Marker({ element: callout, anchor: 'left', offset: [14, 0] }).setLngLat(pos).addTo(map);
  else calloutMarker.setLngLat(pos);
  setHtml(callout, calloutHtml(t, detailFor(t), now));
}

function timeOf(s, kind) {
  if (kind === 'actual') return s.actualDep ?? s.actualArr;
  return s.plannedDep ?? s.plannedArr;
}

function expectedOf(s, delayMin) {
  if (s.expectedArr) return s.expectedArr;
  const planned = s.plannedArr ?? s.plannedDep;
  return planned ? planned + Math.max(0, delayMin) * 60_000 : undefined;
}

const minutesUntil = (ms, now) => Math.max(0, Math.round((ms - now) / 60_000));

function renderDetail(d, scroll) {
  const t = trains.get(d.train.id) ?? d.train;
  const tfl = Boolean(t.mode);
  const now = serverNow();
  renderDetailHead(t);

  setHtml($('d-stock'), stockHtml(t, d.service));
  const status = tfl ? lineStatusOf(t.line) : null;
  setHtml($('d-note'), status
    ? disruptionHtml(t.line, status, false)
    : !tfl && !d.timetabled ? '<p class="note">Only stops reported so far (no timetable feed).</p>' : '');

  // Every stop on the route, with timing points it runs through shown smaller.
  const items = [];
  const nowIndex = t.state === 'moving' ? d.stops.findLastIndex((s) => s.status !== 'upcoming') : -1;
  d.stops.forEach((s, i) => {
    let left = '';
    let right = '';
    let late = false;
    if (tfl) {
      if (s.status === 'upcoming' && s.expectedArr) left = `${minutesUntil(s.expectedArr, now)} min`;
    } else {
      const planned = timeOf(s, 'planned');
      const actual = timeOf(s, 'actual');
      left = hhmm(planned);
      if (s.call && actual) {
        right = hhmm(actual);
        late = planned ? actual - planned >= 60_000 : false;
      } else if (s.call && s.status === 'upcoming' && planned && t.delayMin > 0) {
        right = hhmm(expectedOf(s, t.delayMin));
        late = true;
      }
    }
    items.push(`<li class="call ${s.status}${s.call ? '' : ' pass'}">
      <span class="c-time">${left}</span>
      <span class="c-dot"></span>
      <span class="c-name">${escapeHtml(s.name)}</span>
      <span class="c-rt${late ? ' late' : ''}">${escapeHtml(right)}</span>
    </li>`);
    // The train itself, between the stop it left and the next one.
    if (i === nowIndex && d.stops[i + 1]) items.push('<li class="call now" aria-label="Train is here"><span></span><span class="c-dot"></span></li>');
  });
  const list = $('d-calls');
  list.innerHTML = items.join('');
  // Scroll only the list (scrollIntoView would also scroll the panel and hide
  // the header on phones).
  const focus = scroll && list.querySelector('.now, .current, .upcoming');
  if (focus) list.scrollTop = focus.offsetTop - list.clientHeight / 2 + focus.offsetHeight / 2;
}

// ---- Search ----

let results = [];
let activeResult = -1;

function searchTrains(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const t of trains.values()) {
    if (!visible(t)) continue;
    const hc = (t.headcode || '').toLowerCase();
    const has = (s) => Boolean(s) && s.toLowerCase().includes(q);
    // Headcode, then line or operator, then destination, then where it is now.
    let score = 0;
    if (hc && hc === q) score = 5;
    else if (hc && hc.startsWith(q)) score = 4;
    else if (has(t.operator) || badgeOf(t).code.toLowerCase() === q) score = 3;
    else if (has(t.destination) || has(t.origin)) score = 2;
    else if (has(t.from?.name) || has(t.to?.name)) score = 1;
    if (score) scored.push({ t, score });
  }
  scored.sort((a, b) => b.score - a.score || nameOf(a.t).localeCompare(nameOf(b.t)));
  return scored.slice(0, 8).map((s) => s.t);
}

function renderResults() {
  const list = $('search-results');
  const input = $('search-input');
  if (!input.value.trim()) {
    hideResults();
    return;
  }
  if (!results.length) {
    list.innerHTML = '<li class="result empty" role="option" aria-disabled="true">No matching trains</li>';
  } else {
    list.innerHTML = results.map((t, i) => `
      <li class="result" role="option" id="result-${i}" data-id="${escapeHtml(t.id)}" aria-selected="${i === activeResult}">
        <span class="r-main"><span class="r-title">${shortHtml(t)}</span><span class="r-sub">${escapeHtml(whereLabel(t))}</span></span>
        ${!t.mode && t.delayMin > 0 ? `<span class="r-badge">+${t.delayMin}</span>` : ''}
      </li>`).join('');
  }
  list.hidden = false;
  $('browse').classList.add('searching');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', activeResult >= 0 ? `result-${activeResult}` : '');
}

function hideResults() {
  $('search-results').hidden = true;
  $('browse').classList.remove('searching');
  $('search-input').setAttribute('aria-expanded', 'false');
  activeResult = -1;
}

$('search-input').addEventListener('input', (e) => {
  results = searchTrains(e.target.value);
  activeResult = results.length ? 0 : -1;
  renderResults();
});
$('search-input').addEventListener('focus', (e) => {
  if (e.target.value.trim()) renderResults();
});
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!results.length) return;
    e.preventDefault();
    activeResult = (activeResult + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
    renderResults();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const t = results[Math.max(0, activeResult)];
    if (t) choose(t.id);
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    e.target.value = '';
    hideResults();
  }
});
$('search-input').addEventListener('blur', () => setTimeout(hideResults, 150));
// mousedown keeps focus in the input until the click lands.
$('search-results').addEventListener('mousedown', (e) => e.preventDefault());
$('search-results').addEventListener('click', (e) => {
  const li = e.target.closest('.result[data-id]');
  if (li) choose(li.dataset.id);
});

function choose(id) {
  $('search-input').value = '';
  $('search-input').blur();
  hideResults();
  select(id);
}

// ---- Rendering loop ----

function render() {
  const source = map.getSource('trains');
  const now = serverNow();
  const features = [];
  const counts = { ontime: 0, minor: 0, major: 0 };
  const perNet = {};
  for (const t of trains.values()) {
    if (!visible(t)) continue;
    const cat = category(t);
    if (cat !== 'tfl') counts[cat]++;
    const net = t.mode ?? 'rail';
    perNet[net] = (perNet[net] ?? 0) + 1;
    const { pos, bearing } = locate(t, now);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pos },
      properties: {
        id: t.id,
        // TfL train numbers mean little to riders; label rail headcodes only.
        label: t.mode ? '' : t.headcode,
        // Drawn by trainImage; a plain dot until we know which way it faces.
        icon: `train:${colorOf(t)}:${bearing === null ? 'dot' : 'arrow'}`,
        bearing: bearing ?? 0,
        selected: t.id === selectedId,
      },
    });
  }
  source?.setData({ type: 'FeatureCollection', features });
  renderLegend(features.length, counts, perNet);

  const sel = selectedId && trains.get(selectedId);
  if (sel) {
    $('d-meta').textContent = metaLabel(sel, now);
    drawRouteLine(now);
    if (following && !map.isMoving()) map.jumpTo({ center: positionOf(sel, now), padding: mapPadding() });
  }
  renderCallout(sel, now);
  renderConnection(now);
}

/**
 * How many trains are showing, then the colour key with counts: National
 * Rail by lateness while it is on, otherwise each TfL network shown.
 */
function renderLegend(total, counts, perNet) {
  const cell = (n, label, color) => `<span class="lg"><b>${color ? `<i class="dot" style="background:${color}"></i>` : ''}${n.toLocaleString()}</b>${label}</span>`;
  const cells = [cell(total, 'total')];
  if (shown.has('rail')) {
    cells.push(cell(counts.ontime, 'on time', DELAY_COLORS.ontime), cell(counts.minor, '1–4 min late', DELAY_COLORS.minor), cell(counts.major, '5+ min late', DELAY_COLORS.major));
  } else {
    for (const net of NETWORKS) if (shown.has(net)) cells.push(cell(perNet[net] ?? 0, NET_LABELS[net], NET_COLORS[net]));
  }
  setHtml($('legend'), cells.join(''));
}

/** Green dot while live; a word only when something is wrong. */
function renderConnection(now) {
  const s = lastStatus;
  let state = 'ok';
  let text = '';
  let title = '';
  if (!streamOk) {
    state = 'bad';
    text = s ? 'Reconnecting…' : '';
    title = 'Connecting to the server';
  } else if (s) {
    const last = s.stats?.lastMessageAt;
    title = `Live · last update ${last ? ago(now - last) : '—'} · London time`;
  }
  $('conn-dot').className = `conn-dot ${state}`;
  $('conn-text').textContent = text;
  $('conn-text').hidden = !text;
  $('status').title = title;
}

function applyStatus(s) {
  lastStatus = s;
  const tags = [];
  const credits = [];
  if (s.feed === 'demo') {
    tags.push('<span class="tag demo" title="National Rail trains are simulated in demo mode; TfL trains are live.">Rail simulated</span>');
    credits.push('National Rail trains simulated · Stations: NaPTAN (OGL)');
  } else {
    if (!s.connected) tags.push(`<span class="tag down" title="${escapeHtml(s.detail)}">Rail offline</span>`);
    credits.push(RAIL_ATTRIBUTION);
  }
  const tfl = s.sources?.tfl;
  if (tfl) {
    if (!tfl.connected) tags.push(`<span class="tag down" title="${escapeHtml(tfl.detail)}">TfL offline</span>`);
    credits.push('Powered by TfL Open Data');
  }
  setHtml($('notices'), tags.join(''));
  setAttribution(credits.join(' | '));
  // Rail operators come and go with the trains; disruptions change too.
  renderFilters();
}

let attribution = null;
let attributionText = null;
/** Data credits go in the map's own attribution (the ⓘ), out of the panel. */
function setAttribution(text) {
  if (text === attributionText) return;
  attributionText = text;
  if (attribution) map.removeControl(attribution);
  attribution = new maplibregl.AttributionControl({ compact: true, customAttribution: text || undefined });
  // On phones the bottom sheet would cover the bottom corners, and the open
  // credits would run under the zoom buttons: start them closed behind the ⓘ.
  map.addControl(attribution, isNarrow() ? 'top-left' : 'bottom-right');
  if (isNarrow()) {
    const el = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
    el?.classList.remove('maplibregl-compact-show');
    el?.removeAttribute('open');
  }
}

function setClock(serverTime) {
  if (serverTime) clockOffset = serverTime - Date.now();
}

function tickClock() {
  $('clock').textContent = timeFmt.format(serverNow());
}

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    streamOk = true;
    setClock(d.serverTime);
    trains.clear();
    for (const t of d.trains) trains.set(t.id, t);
    for (const id of headings.keys()) if (!trains.has(id)) headings.delete(id);
    applyStatus(d.status);
    if (selectedId && !trains.has(selectedId)) clearSelection();
  });
  es.addEventListener('delta', (e) => {
    const d = JSON.parse(e.data);
    setClock(d.serverTime);
    for (const id of d.removals) {
      trains.delete(id);
      headings.delete(id);
    }
    for (const t of d.upserts) trains.set(t.id, t);
    if (!selectedId) return;
    const sel = trains.get(selectedId);
    if (!sel) clearSelection();
    else if (stampOf(sel) !== detailStamp) loadDetail(selectedId);
    // Same section: refresh times ("in 3 min") and delay.
    else if (detail) renderDetail(detail, false);
    else renderDetailHead(sel);
  });
  es.addEventListener('status', (e) => applyStatus(JSON.parse(e.data)));
  es.onerror = () => {
    streamOk = false;
    // EventSource retries by itself, except after an HTTP error response
    // (e.g. a proxy 502 during a restart), when it gives up for good.
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 5000);
  };
}

// ---- Map layers ----

// One icon per train, dot and arrow together, so where trains bunch up each
// one covers the ones beneath it (separate dot and arrow layers would draw
// every arrow over every dot).
const TRAIN_ICON_PX = 24;
const TRAIN_ICON_SCALE = 3;

/** A dot in the train's colour with a white rim and, if it has one, an arrow pointing north. */
function trainImage(color, arrow) {
  const s = TRAIN_ICON_PX * TRAIN_ICON_SCALE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - 1 - 0.07 * s, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  if (arrow) {
    const u = s / 72;
    ctx.beginPath();
    ctx.moveTo(36 * u, 17 * u);
    ctx.lineTo(49 * u, 50 * u);
    ctx.lineTo(36 * u, 43 * u);
    ctx.lineTo(23 * u, 50 * u);
    ctx.closePath();
    ctx.fillStyle = textOn(color);
    ctx.fill();
  }
  return ctx.getImageData(0, 0, s, s);
}

// Icons are made the first time a colour shows up ("train:#E32017:arrow").
map.on('styleimagemissing', (e) => {
  const m = /^train:(#[0-9a-fA-F]{6}):(arrow|dot)$/.exec(e.id);
  if (m && !map.hasImage(e.id)) map.addImage(e.id, trainImage(m[1], m[2] === 'arrow'), { pixelRatio: TRAIN_ICON_SCALE });
});

function applyRailLines() {
  if (map.getLayer('openrailwaymap')) {
    for (const id of ['openrailwaymap', 'rail-emphasis']) map.setLayoutProperty(id, 'visibility', railLines ? 'visible' : 'none');
  }
  document.querySelector('.rail-toggle')?.setAttribute('aria-pressed', String(railLines));
}

map.on('load', () => {
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

  // Track overview at every zoom, in neutral grey so it never competes with
  // train colours. OpenRailwayMap's public tiles are fine for a prototype; a
  // production site should host its own.
  map.addSource('openrailwaymap', {
    type: 'raster',
    tiles: ['https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png'],
    tileSize: 256,
    maxzoom: 19,
    attribution: '<a href="https://www.openrailwaymap.org/">OpenRailwayMap</a> (CC-BY-SA)',
  });
  map.addLayer({
    id: 'openrailwaymap',
    type: 'raster',
    source: 'openrailwaymap',
    paint: { 'raster-opacity': 0.45, 'raster-saturation': -1, 'raster-contrast': 0.15 },
  }, firstSymbol);

  // Basemap's own rail geometry: crisper once zoomed in (it starts around z8.5).
  map.addLayer({
    id: 'rail-emphasis',
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'transportation',
    filter: ['all', ['==', ['get', 'class'], 'rail'], ['!', ['has', 'service']]],
    paint: {
      'line-color': '#8d97ab',
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 9, 1.4, 14, 3],
      'line-opacity': 0.8,
    },
  }, firstSymbol);

  // Selected train's route in its colour: covered track pale, track ahead solid.
  map.addSource('route-line', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: 'route-line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 7, 12, 13] },
  });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route-line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      // Over the white casing, a translucent line reads as a pale tint.
      'line-opacity': ['match', ['get', 'part'], 'behind', 0.35, 1],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 4, 12, 8],
    },
  });
  // Stations: small hollow markers, so they never look like trains.
  map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'route-stops',
    type: 'circle',
    source: 'route',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 12, 4],
      'circle-color': '#ffffff',
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-opacity': ['match', ['get', 'status'], 'passed', 0.45, 1],
      'circle-stroke-width': 1.5,
    },
  });
  map.addLayer({
    id: 'route-labels',
    type: 'symbol',
    source: 'route',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
      'text-radial-offset': 0.8,
      'text-justify': 'auto',
    },
    paint: {
      'text-color': ['match', ['get', 'status'], 'passed', '#667085', '#1d2330'],
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.6,
    },
  });

  map.addSource('trains', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  // Trains: filled dots with an arrow for the direction of travel, clearly
  // bigger than station markers; the selected one also gets a dark ring.
  map.addLayer({
    id: 'trains-selected',
    type: 'circle',
    source: 'trains',
    filter: ['==', ['get', 'selected'], true],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 7, 8, 11.5, 12, 15.5],
      'circle-color': 'rgba(0, 0, 0, 0)',
      'circle-stroke-color': '#1d2330',
      'circle-stroke-width': 2.5,
    },
  });
  // TfL trains in their line's colour; National Rail by lateness.
  map.addLayer({
    id: 'trains',
    type: 'symbol',
    source: 'trains',
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      // 24 px icon: about 7 px across for all of Britain, 20 px in a city.
      'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.3, 6, 0.46, 8, 0.6, 12, 0.85, 15, 1],
      // The selected train on top of any it overlaps.
      'symbol-sort-key': ['case', ['get', 'selected'], 1, 0],
    },
  });
  map.addLayer({
    id: 'train-labels',
    type: 'symbol',
    source: 'trains',
    minzoom: 9,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Bold'],
      'text-size': 11,
      'text-offset': [0, 1.3],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: { 'text-color': '#1d2330', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
  });

  map.on('click', (e) => {
    const id = trainAt(e.point);
    if (id) select(id);
    else if (selectedId) clearSelection();
  });
  map.on('mousemove', (e) => showTooltip(trainAt(e.point), e.originalEvent));
  map.on('mouseout', () => showTooltip(null));
  map.on('dragstart', () => { if (following) setFollow(false); });
  if (detail) setRoute(detail);
  applyRailLines();
  setFocusStyle();
  render();
});

/** The train nearest a screen point, within a few pixels (trains bunch up at stations). */
function trainAt(point) {
  if (!map.getLayer('trains')) return null;
  const box = [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]];
  let best = null;
  for (const f of map.queryRenderedFeatures(box, { layers: ['trains'] })) {
    const p = map.project(f.geometry.coordinates);
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (!best || d < best.d) best = { id: f.properties.id, d };
  }
  return best?.id ?? null;
}

function showTooltip(id, event) {
  const tip = $('tooltip');
  const t = id && trains.get(id);
  map.getCanvas().style.cursor = t ? 'pointer' : '';
  // Touch devices have no hover; the tap selects instead.
  if (!t || !event || event.pointerType === 'touch') {
    tip.hidden = true;
    return;
  }
  const late = !t.mode && t.delayMin > 0 ? ` · +${t.delayMin} min` : '';
  tip.innerHTML = `<div class="tt-title">${shortHtml(t)}${escapeHtml(late)}</div><span class="tt-sub">${escapeHtml(whereLabel(t))}</span>`;
  tip.hidden = false;
  const x = Math.min(event.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = Math.min(event.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

// ---- Network and line filter ----
//
// One control per network (the chips). "Lines" lays the chips out as rows
// with each network's lines or operators beside them. A badge is lit only
// when its train would show; picking one while its network is off shows that
// line alone, and hiding a network's last line switches the network off.

/** Badges per network: rail operators seen on the map, then every TfL line. */
function lineGroups() {
  const operators = new Map();
  for (const t of trains.values()) {
    if (t.mode) continue;
    const b = badgeOf(t);
    operators.set(b.key, b);
  }
  return NETWORKS.map((net) => ({
    net,
    badges: net === 'rail'
      ? [...operators.values()].sort((a, b) => a.code.localeCompare(b.code))
      : Object.keys(TFL_LINES[net]).map(tflBadge),
  }));
}

const netOfKey = (key) => (key.startsWith('rail:') ? 'rail' : netOfLine(key.slice(4)));

const SLIDERS_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 6h7M14 6h3M3 14h3M10 14h7"/><circle cx="12" cy="6" r="2"/><circle cx="8" cy="14" r="2"/></svg>';

function renderFilters() {
  const el = $('filters');
  const disrupted = lastStatus?.sources?.tfl?.lines ?? {};
  const groups = lineGroups();
  const chip = ({ net, badges }) => {
    const on = shown.has(net);
    const lit = on ? badges.filter((b) => !hiddenLines.has(b.key)).length : 0;
    const partial = on && badges.length > 1 && lit < badges.length;
    const flagged = badges.some((b) => disrupted[b.key.slice(4)] && b.key.startsWith('tfl:'));
    return `<button type="button" class="chip" data-focus="net:${net}" data-net="${net}" aria-pressed="${on}">`
      + `<span class="net-dot" style="background:${NET_COLORS[net]}"></span>${NET_LABELS[net]}`
      + `${partial ? `<span class="net-count">${lit}/${badges.length}</span>` : ''}`
      + `${flagged && !linesOpen ? '<span class="flag" title="Some lines disrupted"></span>' : ''}</button>`;
  };
  const toggle = `<button type="button" class="lines-toggle" data-focus="toggle" aria-expanded="${linesOpen}" title="Choose lines and operators">${SLIDERS_ICON}Lines</button>`;

  let html;
  if (!linesOpen) {
    html = `<div class="chips">${toggle}${groups.map(chip).join('')}</div>`;
  } else {
    const rows = groups.map((g) => {
      const on = shown.has(g.net);
      const badges = g.badges.length > 1 ? g.badges.map((b) => {
        const status = b.key.startsWith('tfl:') ? disrupted[b.key.slice(4)] : null;
        const flag = status ? `<span class="flag${status.closed ? ' closed' : ''}"></span>` : '';
        const label = `${b.name}${status ? ` (${status.summary})` : ''}`;
        return `<button type="button" class="lf-btn" data-focus="line:${escapeHtml(b.key)}" data-key="${escapeHtml(b.key)}" aria-pressed="${on && !hiddenLines.has(b.key)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${badgeHtml(b)}${flag}</button>`;
      }).join('') : '';
      return `${chip(g)}<div class="net-lines">${badges}</div>`;
    }).join('');
    // Closed lines first: they explain why a line has no trains.
    const issues = Object.entries(disrupted)
      .sort(([a, s], [b, t]) => Number(t.closed) - Number(s.closed) || lineName(a).localeCompare(lineName(b)))
      .map(([line, s]) => disruptionHtml(line, s, true)).join('');
    html = `<div class="filters-bar">${toggle}<span class="spacer"></span>`
      + '<button type="button" class="link-btn" data-focus="act:all" data-act="all">Show all</button>'
      + '<button type="button" class="link-btn" data-focus="act:none" data-act="none">Hide all</button></div>'
      + `<div class="net-rows">${rows}</div>`
      + (issues ? `<div class="disruptions">${issues}</div>` : '');
  }

  // Keep keyboard focus and the chip row's scroll position across redraws.
  const focused = el.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  const scrollLeft = el.querySelector('.chips')?.scrollLeft ?? 0;
  if (!setHtml(el, html)) return;
  el.classList.toggle('open', linesOpen);
  const chips = el.querySelector('.chips');
  if (chips) chips.scrollLeft = scrollLeft;
  if (focused) el.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
}

function applyFilter(networks, hidden) {
  shown = new Set(networks.filter((n) => NETWORKS.includes(n)));
  hiddenLines = new Set(hidden);
  try {
    localStorage.setItem('networks', JSON.stringify([...shown]));
    localStorage.setItem('hiddenLines', JSON.stringify([...hiddenLines]));
  } catch { /* storage unavailable */ }
  const sel = selectedId && trains.get(selectedId);
  if (sel && !visible(sel)) clearSelection();
  renderFilters();
  render();
}

function toggleNetwork(net) {
  const next = new Set(shown);
  if (next.has(net)) next.delete(net);
  else next.add(net);
  // Either way the network comes back with all its lines next time.
  applyFilter([...next], [...hiddenLines].filter((k) => netOfKey(k) !== net));
}

function toggleLine(key) {
  const net = netOfKey(key);
  const keys = lineGroups().find((g) => g.net === net)?.badges.map((b) => b.key) ?? [];
  const nets = new Set(shown);
  const hidden = new Set(hiddenLines);
  if (!nets.has(net)) {
    // Network off: show just this line.
    nets.add(net);
    for (const k of keys) if (k !== key) hidden.add(k);
    hidden.delete(key);
  } else if (hidden.has(key)) {
    hidden.delete(key);
  } else {
    hidden.add(key);
    if (keys.every((k) => hidden.has(k))) {
      nets.delete(net);
      for (const k of keys) hidden.delete(k);
    }
  }
  applyFilter([...nets], [...hidden]);
}

$('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.classList.contains('lines-toggle')) {
    linesOpen = !linesOpen;
    renderFilters();
  } else if (btn.dataset.act === 'all') {
    applyFilter(NETWORKS, []);
  } else if (btn.dataset.act === 'none') {
    applyFilter([], []);
  } else if (btn.dataset.net) {
    toggleNetwork(btn.dataset.net);
  } else if (btn.dataset.key) {
    toggleLine(btn.dataset.key);
  }
});

// ---- Controls ----

/** Map button that shows or hides the railway lines overlay. */
class RailLinesControl {
  onAdd() {
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.el.innerHTML = `<button type="button" class="rail-toggle" aria-pressed="${railLines}" title="Railway lines" aria-label="Railway lines">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M7.5 2.5 6 17.5M12.5 2.5 14 17.5M5.6 6h8.8M5.2 10h9.6M4.8 14h10.4"/></svg></button>`;
    this.el.querySelector('button').addEventListener('click', () => {
      railLines = !railLines;
      try { localStorage.setItem('railLines', JSON.stringify(railLines)); } catch { /* storage unavailable */ }
      applyRailLines();
    });
    return this.el;
  }

  onRemove() {
    this.el.remove();
  }
}

try { railLines = JSON.parse(localStorage.getItem('railLines') ?? 'true') !== false; } catch { /* storage unavailable */ }
map.addControl(new RailLinesControl(), 'top-right');
setAttribution('');

try { hiddenLines = new Set(JSON.parse(localStorage.getItem('hiddenLines') ?? '[]')); } catch { /* storage unavailable */ }
let savedNetworks = null;
try { savedNetworks = JSON.parse(localStorage.getItem('networks') ?? 'null'); } catch { /* storage unavailable */ }
applyFilter(Array.isArray(savedNetworks) ? savedNetworks : NETWORKS, [...hiddenLines]);

$('d-close').addEventListener('click', clearSelection);
$('d-fit').addEventListener('click', fitRoute);
$('d-follow').addEventListener('click', () => setFollow(!following));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectedId && document.activeElement !== $('search-input')) clearSelection();
});

setInterval(render, FRAME_MS);
setInterval(tickClock, 1000);
tickClock();
window.addEventListener('resize', () => map.resize());
connect();
