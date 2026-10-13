import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts'],
  outfile: '.generated/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
});
