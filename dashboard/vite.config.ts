import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// `npm run dev` serves the page with hot reload and forwards the API to a running server on :7878
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:7878', '/ws': { target: 'ws://127.0.0.1:7878', ws: true } } },
})
