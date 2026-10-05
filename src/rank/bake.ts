// Applies src/rank to public/data/candidates.json in place and writes the mock-candidates.json fixture.
// Run: npm run rank:bake   (Node >= 22.18 runs .ts directly)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CandidatesFile } from '../contracts.ts';
import { DEFAULT_QUICK_WEIGHTS, DEFAULT_THRESHOLDS, rankCandidates, shortlist } from './index.ts';

const dataDir = fileURLToPath(new URL('../../public/data/', import.meta.url));
const file: CandidatesFile = JSON.parse(readFileSync(dataDir + 'candidates.json', 'utf8'));

const ranked = rankCandidates(file.candidates);
const short = shortlist(ranked);
file.candidates = ranked;
file.meta.rank = { thresholds: DEFAULT_THRESHOLDS, weights: DEFAULT_QUICK_WEIGHTS, shortlist: short.map(c => c.id) };

writeFileSync(dataDir + 'candidates.json', JSON.stringify(file));
writeFileSync(dataDir + 'mock-candidates.json', JSON.stringify(ranked));

const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log(`ranked ${ranked.length} candidates: ${ranked.filter(c => c.passedFilter).length} pass, ` +
            `${ranked.filter(c => !c.passedFilter).length} rejected`);
for (const c of ranked)
  console.log(`  ${pad(c.quickRank ?? '-', 3)} ${pad(c.id, 34)} ${pad(c.kind, 12)} ` +
              (c.passedFilter ? `score ${c.quickScore}` : `REJECTED: ${c.rejectReason}`));
console.log(`shortlist: ${short.map(c => c.id).join(', ')}`);
