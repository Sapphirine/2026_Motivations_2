import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const workerOrigin = process.env.VITE_WORKER_ORIGIN ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: workerOrigin,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
