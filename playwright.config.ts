import { defineConfig, devices } from '@playwright/test';

const port = process.env.PORT ?? '5173';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  workers: 1, // timing specs (ranking, perf) are unreliable under parallel load
  use: { baseURL },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      // Headless Chromium falls back to software WebGL (~1 fps); force the GPU for deck.gl specs.
      launchOptions: { args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan'] },
    },
  }],
  webServer: {
    command: 'npx vite --port $PORT --strictPort',
    env: { PORT: port },
    url: baseURL,
    reuseExistingServer: true,
  },
});
