import { defineConfig } from "vitest/config";

// contracts/lib contains cloned Foundry deps (OpenZeppelin ships its own JS
// test suite) — only run this package's tests.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
