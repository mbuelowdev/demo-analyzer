// Bundles the server into dist/ (API, worker, task child). Native deps stay external.
import { build } from 'esbuild';

await build({
  entryPoints: { main: 'src/main.ts', worker: 'src/worker/main.ts', task: 'src/worker/task.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
