import { fixtureBrief, fixtureSim } from './fixtures';
import { httpBrief } from './http';
import type { BriefClient, SimClient } from './types';
import { workerSim } from './worker';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const useFixtures = params.get('data') === 'fixtures';

/** `?brief=live` talks to the Part D server (`npm run server`); the default keeps the fixture brief used by e2e. */
export const LIVE_BRIEF = params.get('brief') === 'live';

/** Live engine in a Web Worker by default; `?data=fixtures` keeps the fixture path. */
export const sim: SimClient = useFixtures || typeof Worker === 'undefined' ? fixtureSim : workerSim();
export const briefClient: BriefClient = LIVE_BRIEF ? httpBrief : fixtureBrief;
