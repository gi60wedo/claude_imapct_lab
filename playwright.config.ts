import { defineConfig, devices } from '@playwright/test';

const port = process.env.PORT ?? '5173';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  use: { baseURL },
  // Use the real GPU through ANGLE/Vulkan; the default SwiftShader software renderer cannot hold the scene frame budget.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] } } }],
  webServer: {
    command: 'npx vite --port $PORT --strictPort',
    env: { PORT: port },
    url: baseURL,
    reuseExistingServer: true,
  },
});
