// Dev-only: extracts Saturday U-Bahn/tram arrivals per Altstadt station from the VGN GTFS feed into
// src/sim/dev/data/stations.dev.json. A's prep/ owns the real arrivals.json; this unblocks B until then.
// Usage: npm run sim:dev-data   (needs `unzip` on PATH)
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { StationArrivals } from '../world';
import { BBOX, normalizeStation, REPO, STATIONS_PATH } from './osmWorld';

const ZIP = resolve(REPO, 'datasets/gtfs/vgn_gtfs.zip');
const SATURDAY = '20261010';
const WINDOW = [5 * 3600, 15.5 * 3600];

function lines(file: string): AsyncIterable<string> {
  const p = spawn('unzip', ['-p', ZIP, file]);
  return createInterface({ input: p.stdout, crlfDelay: Infinity });
}

function parse(line: string): string[] {
  return line.replace(/^﻿/, '').split(',').map((c) => c.replace(/^"|"$/g, ''));
}

async function table(file: string, onRow: (row: Record<string, string>) => void) {
  let header: string[] | null = null;
  for await (const line of lines(file)) {
    if (!line) continue;
    const cols = parse(line);
    if (!header) { header = cols; continue; }
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cols[i]));
    onRow(row);
  }
}

async function main() {
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

  mkdirSync(dirname(STATIONS_PATH), { recursive: true });
  writeFileSync(STATIONS_PATH, JSON.stringify(stations));
  for (const s of stations) console.log(`${s.mode.padEnd(6)} ${s.name.padEnd(28)} ${s.arrivals.length} arrivals`);
  console.log(`→ ${STATIONS_PATH} (Saturday ${SATURDAY})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
