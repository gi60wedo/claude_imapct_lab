import { describe, expect, it } from 'vitest';
import { uncheckedNumbers } from '../dev/briefs';

const facts = { sites: [{ site: 'kaufhof', marketScore: 67.1, criteria: { fairness: 86.5 } }, { site: 'hauptmarkt', marketScore: 63.2 }],
                stakeholders: { vendor: { mainProblem: '46 m carry from the loading point' } } };
const brief = (text: string) => ({ headline: text, why: [], tradeoff: '', nextStep: '' });

describe('brief number check (rule zero)', () => {
  it('accepts numbers that appear in the facts, including rounding and small counts', () => {
    expect(uncheckedNumbers(brief('Kaufhof 67.1 beats Hauptmarkt 63.2; fairness 86.5, a 46 m carry, wins 2 of 3'), facts)).toEqual([]);
    expect(uncheckedNumbers(brief('fairness 86.6'), facts)).toEqual([]);   // ±0.1 rounding
  });
  it('flags numbers Claude did not get from the simulation', () => {
    expect(uncheckedNumbers(brief('Kaufhof scores 71.4 and saves 28 minutes'), facts)).toEqual(['71.4', '28']);
  });
});
