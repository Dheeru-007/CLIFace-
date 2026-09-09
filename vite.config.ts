import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Forwards /api/* from the Vite dev server (default port 5173) to the real
      // Express backend, so fetch("/api/run") works in `npm run dev` without the
      // frontend needing to know the backend's port. In production, both would
      // typically be served from the same origin instead, so this only matters for dev.
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
})