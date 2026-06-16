import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Separate from vite.config.ts so the jsdom test environment and the
// jest-dom setup never leak into the production Vite build.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    // Component tests assert on rendered output, not on which hooks are used,
    // so they stay valid regardless of the fetching implementation underneath.
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
  },
});
