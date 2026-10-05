// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const subprocess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: subprocess.spawn }));
import { buildDevData } from '../dev/buildDevData';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function extraction(mode: 'failed' | 'empty' | 'malformed' | 'valid' | 'spawn-error' | 'quoted') {
  const root = mkdtempSync(resolve(tmpdir(), 'sim-gtfs-'));
  roots.push(root);
  mkdirSync(resolve(root, 'data'));
  const destination = resolve(root, 'data/stations.dev.json');
  const previous = '[{"name":"Preserved","arrivals":[41400]}]';
  writeFileSync(destination, previous);
  const tables: Record<string, string> = {
    'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type\n' +
      (mode === 'quoted' ? 's,"Nürnberg Test, ""Exit""",49.45,11.075,0\n' : 's,Nürnberg Test,49.45,11.075,0\n'),
    'routes.txt': 'route_id,route_type\nr,1\n',
    'calendar.txt': 'service_id,saturday,start_date,end_date\nservice,1,20260101,20261231\n',
    'calendar_dates.txt': 'service_id,date,exception_type\n',
    'trips.txt': 'route_id,service_id,trip_id\nr,service,t\n',
    'stop_times.txt': 'trip_id,stop_id,arrival_time\n' + (mode === 'empty' ? '' : `t,s,${mode === 'malformed' ? 'invalid' : '11:30:00'}\n`),
  };
  subprocess.spawn.mockImplementation((_command: string, args: string[]) => {
    const file = args.at(-1)!;
    const failed = mode === 'failed' && file === 'stop_times.txt';
    const child = Object.assign(new EventEmitter(), {
      stdout: Readable.from([mode === 'spawn-error' ? '' : tables[file]]),
      stderr: Readable.from([failed ? 'extraction failed' : '']),
      kill: vi.fn(),
    });
    child.stdout.on('end', () => setTimeout(() => {
      if (mode === 'spawn-error') child.emit('error', new Error('unzip unavailable'));
      child.emit('close', failed || mode === 'spawn-error' ? 9 : 0, null);
    }, 0));
    return child;
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return { root, destination, previous };
}

describe('GTFS extraction replacement', () => {
  it.each(['failed', 'empty', 'malformed', 'spawn-error'] as const)('preserves valid arrivals when extraction is %s', async (mode) => {
    const r = extraction(mode);
    await expect(buildDevData(r.destination)).rejects.toThrow();
    expect(readFileSync(r.destination, 'utf8')).toBe(r.previous);
    expect(readdirSync(resolve(r.root, 'data'))).toEqual(['stations.dev.json']);
  });
  it('replaces arrivals after successful extraction and leaves no temporary files', async () => {
    const r = extraction('valid');
    await buildDevData(r.destination);
    expect(JSON.parse(readFileSync(r.destination, 'utf8'))).toEqual([
      { name: 'Test', lng: 11.075, lat: 49.45, mode: 'subway', arrivals: [41400] },
    ]);
    expect(readdirSync(resolve(r.root, 'data'))).toEqual(['stations.dev.json']);
  });
  it('accepts valid GTFS names containing quoted commas and escaped quotes', async () => {
    const r = extraction('quoted');
    await buildDevData(r.destination);
    expect(JSON.parse(readFileSync(r.destination, 'utf8'))[0].name).toBe('Test, "Exit"');
  });
});
