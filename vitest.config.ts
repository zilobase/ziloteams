import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { reporter: ["text", "html"] },
    include: ["packages/**/*.test.ts", "apps/api/**/*.test.ts", "apps/cli/**/*.test.ts"]
  }
});
