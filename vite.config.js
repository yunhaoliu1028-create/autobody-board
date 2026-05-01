import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,   // exposes to local network → access from iOS on same Wi-Fi
    port: 5173,
  },
})
