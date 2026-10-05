// Dev-only: extracts Saturday U-Bahn/tram arrivals per Altstadt station from the VGN GTFS feed into
// src/sim/dev/data/stations.dev.json. A's prep/ owns the real arrivals.json; this unblocks B until then.
// Usage: npm run sim:dev-data   (needs `unzip` on PATH)
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { StationArrivals } from '../world';
import { BBOX, normalizeStation, REPO, STATIONS_PATH } from './osmWorld';

const ZIP = resolve(REPO, 'datasets/gtfs/vgn_gtfs.zip');
const SATURDAY = '20261010';
const WINDOW = [5 * 3600, 15.5 * 3600];

async function* lines(file: string): AsyncIterable<string> {
  const p = spawn('unzip', ['-p', ZIP, file]);
  let stderr = '';
  p.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4096); });
  // Attach listeners before consuming stdout. Resolve errors as values to avoid an unhandled
  // rejection while a large table is still streaming.
  let finished = false;
  const completion = new Promise<{ code: number | null; signal?: string | null; error?: Error }>((done) => {
    p.once('error', (error) => { finished = true; done({ code: null, error }); });
    p.once('close', (code, signal) => { finished = true; done({ code, signal }); });
  });
  const reader = createInterface({ input: p.stdout, crlfDelay: Infinity });
  try {
    for await (const line of reader) yield line;
    const result = await completion;
    if (result.error || result.code !== 0) {
      throw new Error(`GTFS extraction failed for ${file}: ${result.error?.message ?? result.signal ?? `exit ${result.code}`} ${stderr}`.trim());
    }
  } finally {
    reader.close();
    if (!finished) p.kill();
  }
}

function parse(line: string): string[] {
  const cols: string[] = [];
  let value = '', quoted = false;
  line = line.replace(/^﻿/, '');
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { cols.push(value); value = ''; }
    else value += c;
  }
  if (quoted) throw new Error('Unterminated quote in GTFS CSV');
  cols.push(value);
  return cols;
}

async function table(file: string, onRow: (row: Record<string, string>) => void) {
  console.log(`Reading GTFS ${file}`);
  let header: string[] | null = null;
  for await (const line of lines(file)) {
    if (!line) continue;
    const cols = parse(line);
    if (!header) {
      if (cols.some((c) => !c) || new Set(cols).size !== cols.length) throw new Error(`Invalid GTFS header in ${file}`);
      header = cols; continue;
    }
    if (cols.length !== header.length) throw new Error(`Invalid GTFS row in ${file}`);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cols[i]));
    onRow(row);
  }
  if (!header) throw new Error(`Empty GTFS table ${file}`);
}

export async function buildDevData(destination = STATIONS_PATH) {
  const weekday = new Date(`${SATURDAY.slice(0, 4)}-${SATURDAY.slice(4, 6)}-${SATURDAY.slice(6)}`).getDay();
  if (weekday !== 6) throw new Error(`${SATURDAY} is not a Saturday`);

  // Group platforms by station name: some stations (e.g. Weißer Turm) have no parent_station.
  const pad = 0.002;   // keeps Plärrer, just west of the bbox
  const parents = new Map<string, { name: string; lat: number; lng: number; n: number }>();
  const stopToParent = new Map<string, string>();
  await table('stops.txt', (r) => {
    const lat = +r.stop_lat, lng = +r.stop_lon;
    const inside = lat >= BBOX.minLat - pad && lat <= BBOX.maxLat + pad && lng >= BBOX.minLng - pad && lng <= BBOX.maxLng + pad;
    if (!inside || r.location_type === '1' || !r.stop_name.startsWith('Nürnberg ')) return;
    const name = normalizeStation(r.stop_name);
    const p = parents.get(name) ?? { name, lat: 0, lng: 0, n: 0 };
    p.lat += lat; p.lng += lng; p.n++;
    parents.set(name, p);
    stopToParent.set(r.stop_id, name);
  });
  for (const p of parents.values()) { p.lat /= p.n; p.lng /= p.n; }

  const routeMode = new Map<string, 'subway' | 'tram'>();
  await table('routes.txt', (r) => {
    if (r.route_type === '1') routeMode.set(r.route_id, 'subway');
    if (r.route_type === '0') routeMode.set(r.route_id, 'tram');
  });

  const active = new Set<string>();
  await table('calendar.txt', (r) => {
    if (r.saturday === '1' && r.start_date <= SATURDAY && r.end_date >= SATURDAY) active.add(r.service_id);
  });
  await table('calendar_dates.txt', (r) => {
    if (r.date !== SATURDAY) return;
    if (r.exception_type === '1') active.add(r.service_id);
    if (r.exception_type === '2') active.delete(r.service_id);
  });

  const tripMode = new Map<string, 'subway' | 'tram'>();
  await table('trips.txt', (r) => {
    const mode = routeMode.get(r.route_id);
    if (mode && active.has(r.service_id)) tripMode.set(r.trip_id, mode);
  });

  const arrivals = new Map<string, { mode: 'subway' | 'tram'; times: number[] }>();
  await table('stop_times.txt', (r) => {
    const mode = tripMode.get(r.trip_id);
    const parent = mode && stopToParent.get(r.stop_id);
    if (!parent || !parents.has(parent)) return;
    if (!/^\d{2,}:[0-5]\d:[0-5]\d$/.test(r.arrival_time)) throw new Error(`Invalid GTFS arrival ${r.arrival_time}`);
    const [h, m, s] = r.arrival_time.split(':').map(Number);
    const t = h * 3600 + m * 60 + s;
    if (t < WINDOW[0] || t > WINDOW[1]) return;
    const key = `${parent}|${mode}`;
    let a = arrivals.get(key);
    if (!a) arrivals.set(key, (a = { mode: mode!, times: [] }));
    a.times.push(t);
  });

  const stations: StationArrivals[] = [...arrivals.entries()].map(([key, a]) => {
    const p = parents.get(key.split('|')[0])!;
    return { name: p.name, lng: +p.lng.toFixed(6), lat: +p.lat.toFixed(6), mode: a.mode, arrivals: a.times.sort((x, y) => x - y) };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.mode.localeCompare(b.mode));

  if (!stations.length || stations.some((s) => !s.name || !Number.isFinite(s.lng) || !Number.isFinite(s.lat) ||
    !s.arrivals.length || s.arrivals.some((t) => !Number.isInteger(t) || t < WINDOW[0] || t > WINDOW[1]))) {
    throw new Error('GTFS extraction produced no valid station arrivals');
  }
  mkdirSync(dirname(destination), { recursive: true });
  const tempDir = mkdtempSync(resolve(dirname(destination), '.stations-'));
  try {
    const temp = resolve(tempDir, 'stations.json');
    writeFileSync(temp, JSON.stringify(stations), { flag: 'wx' });
    renameSync(temp, destination);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  for (const s of stations) console.log(`${s.mode.padEnd(6)} ${s.name.padEnd(28)} ${s.arrivals.length} arrivals`);
  console.log(`→ ${destination} (Saturday ${SATURDAY})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildDevData().catch((e) => { console.error(e); process.exitCode = 1; });
}
