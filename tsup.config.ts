import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  outDir: "dist",
  // Resolve @/ path aliases at build time
  esbuildOptions(options) {
    options.alias = {
      "@": "./src",
    };
  },
  // Keep all dependencies external (they're in node_modules)
  noExternal: [],
  splitting: false,
  sourcemap: true,
});
