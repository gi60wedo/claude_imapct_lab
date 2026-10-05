import { fixtureBrief, fixtureSim } from './fixtures';
import type { BriefClient, SimClient } from './types';
import { workerSim } from './worker';

const useFixtures = typeof location !== 'undefined' && new URLSearchParams(location.search).get('data') === 'fixtures';

/** Live engine in a Web Worker by default; `?data=fixtures` keeps the fixture path. Brief stays on fixtures until D's /api/brief lands. */
export const sim: SimClient = useFixtures || typeof Worker === 'undefined' ? fixtureSim : workerSim();
export const briefClient: BriefClient = fixtureBrief;
