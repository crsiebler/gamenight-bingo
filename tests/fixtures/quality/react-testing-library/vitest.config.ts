import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: "jsdom",
    include: ["invalid.dom.test.tsx"],
    setupFiles: ["../../../setup-dom.ts"],
  },
});
