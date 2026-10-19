import { defineConfig } from "vite";
import { resolve } from "node:path";

// The island demo for the website (dev/landing.html), built with relative paths so it
// runs from any folder. No sounds: the demo is silent.
export default defineConfig({
  publicDir: false,
  base: "./",
  build: {
    target: "es2020",
    outDir: "dist-landing",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: { landing: resolve(__dirname, "dev/landing.html") } },
  },
});
