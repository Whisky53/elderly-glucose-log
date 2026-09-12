/**
 * 把 API 打成单个自包含 ESM 文件。
 * node: 前缀的内置模块全部 external，产物零运行时依赖，
 * 部署时只需复制 dist/server.mjs，服务器上不需要 npm install。
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  minify: false,
  // 内置模块与第三方一律不打包：产物只含本项目源码
  external: ['node:*'],
  banner: {
    js: '// 血糖管理同步 API — 由 scripts/bundle.mjs 生成，请勿直接编辑',
  },
  logLevel: 'info',
});
