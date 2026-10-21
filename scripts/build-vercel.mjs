import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';

await build({
  entryPoints: ['server/index.ts'],
  outfile: '.generated/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
});
await copyFile('server/pdf-text-worker.mjs', '.generated/pdf-text-worker.mjs');
