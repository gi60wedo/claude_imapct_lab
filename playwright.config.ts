import { defineConfig, devices } from '@playwright/test';

const port = process.env.PORT ?? '5173';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  use: { baseURL },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite --port $PORT --strictPort',
    env: { PORT: port },
    url: baseURL,
    reuseExistingServer: true,
  },
});
