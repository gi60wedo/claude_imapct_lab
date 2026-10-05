import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      // UI components need a DOM.
      { extends: true, test: { name: 'ui', environment: 'jsdom', include: ['src/ui/**/*.test.{ts,tsx}'] } },
      // Data, simulation, scoring and server code run in Node (they read files via import.meta.url).
      { extends: true, test: { name: 'node', environment: 'node', include: ['src/{rank,sim,score}/**/*.test.ts', 'server/**/*.test.ts'] } },
    ],
  },
});
