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
  server: { port: 5175, host: true },
});
