import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: ["es2021", "chrome105", "safari13"],
    rollupOptions: {
      input: {
        pet: resolve(__dirname, "pet.html"),
        panel: resolve(__dirname, "panel.html"),
      },
    },
  },
});
