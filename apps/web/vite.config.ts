import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@gms/contracts': path.resolve(__dirname, '../../packages/contracts/src/index.ts'),
      '@gms/domain': path.resolve(__dirname, '../../packages/domain/src/index.ts'),
    },
  },
  server: {
    port: 5175,
    host: true,
    proxy: {
      // 开发时把 /api 转给本机同步后端（默认 8100）；生产由 Nginx 承担同一职责
      '/api': { target: process.env['GMS_API_TARGET'] ?? 'http://127.0.0.1:8100', changeOrigin: true },
    },
  },
});
