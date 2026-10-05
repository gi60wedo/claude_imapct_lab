import { fixtureBrief, fixtureSim } from './fixtures';
import { httpBrief } from './http';
import type { BriefClient, SimClient } from './types';

/** `?brief=live` talks to the Part D server (`npm run server`); the default keeps the fixture path used by e2e. */
export const LIVE_BRIEF = typeof location !== 'undefined' && new URLSearchParams(location.search).get('brief') === 'live';

/** Integration swaps the sim for the worker adapter. */
export const sim: SimClient = fixtureSim;
export const briefClient: BriefClient = LIVE_BRIEF ? httpBrief : fixtureBrief;
