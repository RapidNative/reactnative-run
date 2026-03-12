import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5201,
    allowedHosts: true,
    proxy: {
      "/pkg": {
        target: "http://localhost:5200",
        changeOrigin: true,
      },
    },
  },
});
