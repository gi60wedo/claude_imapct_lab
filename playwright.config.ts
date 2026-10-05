import { defineConfig, devices } from '@playwright/test';

const port = process.env.PORT ?? '5173';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  workers: 1, // timing specs (ranking, perf) are unreliable under parallel load
  use: { baseURL },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite --port $PORT --strictPort',
    env: { PORT: port },
    url: baseURL,
    reuseExistingServer: true,
  },
});
