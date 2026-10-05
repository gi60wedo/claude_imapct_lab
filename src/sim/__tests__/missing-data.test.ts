// @vitest-environment node
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checked: [] as string[],
  loaded: false,
  exists: vi.fn((file: string) => {
    mocks.checked.push(file);
    return !file.endsWith('nuernberg_population_100m.csv');
  }),
  build: vi.fn(() => {
    mocks.loaded = true;
    throw new Error('Skipped integration suite attempted to load missing data');
  }),
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(), existsSync: mocks.exists,
}));
vi.mock('../dev/osmWorld', async (importOriginal) => ({
  ...await importOriginal<typeof import('../dev/osmWorld')>(), buildOsmWorld: mocks.build,
}));

// Import during collection: a skipped suite must not load its world in the factory.
import './nuremberg.test';

it('skips real-data integration safely when a required Zensus file is missing', () => {
  expect(mocks.loaded).toBe(false);
  const checked = mocks.checked;
  for (const suffix of ['altstadt.json', 'stations.dev.json', 'nuernberg_population_100m.csv', 'nuernberg_share_65plus_100m.csv']) {
    expect(checked.some((file) => file.endsWith(suffix)), JSON.stringify(checked)).toBe(true);
  }
});
