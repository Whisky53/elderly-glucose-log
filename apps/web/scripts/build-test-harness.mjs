/**
 * 把前端源码里参与同步的模块打包成 Node 可直接导入的产物，供 tests/sync-e2e.mjs 使用。
 * 之所以要打包：源码是 TypeScript，且通过 @gms/* 别名引用共享包，Node 无法直接加载。
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const repoRoot = path.resolve(webRoot, '../..');

await build({
  entryPoints: [path.join(webRoot, 'tests/sync-harness.ts')],
  outfile: path.join(webRoot, 'tests/.build/harness.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  alias: {
    '@gms/contracts': path.join(repoRoot, 'packages/contracts/src/index.ts'),
    '@gms/domain': path.join(repoRoot, 'packages/domain/src/index.ts'),
  },
  logLevel: 'info',
});
