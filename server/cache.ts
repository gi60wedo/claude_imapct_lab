import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Brief } from '../src/contracts';
import type { BriefPayload } from './briefInput';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CACHE_FILE = join(here, 'cache', 'briefs.json');

type Store = Record<string, { savedAt: string; brief: Brief }>;

/** Exact input → brief, plus a `<scenario>:latest` pointer so the demo still answers when weights drift. */
export class BriefCache {
  constructor(private readonly file = DEFAULT_CACHE_FILE) {}

  static keyFor(p: BriefPayload): string {
    const digest = createHash('sha1').update(JSON.stringify(p)).digest('hex').slice(0, 12);
    return `${p.scenario}:${digest}`;
  }

  private read(): Store {
    try { return JSON.parse(readFileSync(this.file, 'utf8')) as Store; } catch { return {}; }
  }

  get(p: BriefPayload): { brief: Brief; exact: boolean } | undefined {
    const store = this.read();
    const exact = store[BriefCache.keyFor(p)];
    if (exact) return { brief: exact.brief, exact: true };
    const latest = store[`${p.scenario}:latest`];
    return latest ? { brief: latest.brief, exact: false } : undefined;
  }

  put(p: BriefPayload, brief: Brief): void {
    const store = this.read();
    const entry = { savedAt: new Date().toISOString(), brief };
    store[BriefCache.keyFor(p)] = entry;
    store[`${p.scenario}:latest`] = entry;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(store, null, 2));
  }
}
