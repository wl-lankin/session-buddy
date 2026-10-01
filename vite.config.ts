import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Sounds live in /sounds and are served / copied as static assets.
export default defineConfig({
  publicDir: false,
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1", fs: { allow: ["."] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        island: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
      },
    },
  },
  plugins: [
    {
      name: "sb-sounds",
      configureServer(server) {
        server.middlewares.use("/sounds", (req, res, next) => {
          const name = decodeURIComponent((req.url ?? "").replace(/^\//, "").split("?")[0]);
          if (!/^[a-z]+\.wav$/.test(name)) return next();
          res.setHeader("Content-Type", "audio/wav");
          import("node:fs").then((fs) => fs.createReadStream(resolve(__dirname, "sounds", name)).pipe(res));
        });
      },
      async closeBundle() {
        const fs = await import("node:fs");
        const out = resolve(__dirname, "dist/sounds");
        fs.mkdirSync(out, { recursive: true });
        for (const f of fs.readdirSync(resolve(__dirname, "sounds"))) {
          if (f.endsWith(".wav")) fs.copyFileSync(resolve(__dirname, "sounds", f), resolve(out, f));
        }
      },
    },
  ],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: true,
  },
});
