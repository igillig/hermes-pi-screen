import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_HERMES_API_URL ?? 'http://localhost:8000',
        rewrite: (path) => path.replace(/^\/api/, ''),
        changeOrigin: true,
      },
      '/audio': {
        target: process.env.VITE_AUDIO_SERVICE_URL ?? 'http://localhost:8001',
        rewrite: (path) => path.replace(/^\/audio/, ''),
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})
