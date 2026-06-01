import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/recorder.js': 'http://localhost:8787',
      '/recorder-test': 'http://localhost:8787',
      '/vendor': 'http://localhost:8787',
    },
  },
})
