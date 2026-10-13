import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-report.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:43127',
    launchOptions: { executablePath: process.env.CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined), args: ['--no-sandbox'] },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm start',
    env: { OFFLINE: '1', S2_API_KEY: '', DEFAULT_PROVIDER: 'openalex', PORT: '43127', HOST: '127.0.0.1' },
    url: 'http://127.0.0.1:43127/api/health',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
