import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
