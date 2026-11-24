import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the dashboard runs on :5173 and forwards API + WebRTC signalling to the Python server.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:7860" } },
});
