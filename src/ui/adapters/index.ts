import { fixtureBrief, fixtureSim } from './fixtures';
import type { BriefClient, SimClient } from './types';

/** Integration swaps these for the worker / http adapters; `?data=fixtures` keeps the fixture path. */
export const sim: SimClient = fixtureSim;
export const briefClient: BriefClient = fixtureBrief;
