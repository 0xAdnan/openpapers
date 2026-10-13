import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../.generated/server.mjs';

const { app } = createApp({
  cacheDirectory: join(tmpdir(), 'openpapers-cache'),
  snapshotPath: join(process.cwd(), 'data', 'snapshot.json'),
  maxResponseBytes: 4 * 1024 * 1024,
});

export default app;
