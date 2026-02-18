import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: true,
    proxy: {
      "/pkg": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
