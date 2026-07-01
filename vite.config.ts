import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': {
          target: env.VITE_HERMES_API_URL ?? 'http://localhost:8000',
          rewrite: (path) => path.replace(/^\/api/, ''),
          changeOrigin: true,
        },
        '/audio': {
          target: env.VITE_AUDIO_SERVICE_URL ?? 'http://localhost:8001',
          rewrite: (path) => path.replace(/^\/audio/, ''),
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
    },
  }
})
