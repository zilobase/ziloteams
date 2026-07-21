import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { reporter: ["text", "html"] },
    exclude: [...configDefaults.exclude, "apps/api/**/*.worker.test.ts"],
    include: ["packages/**/*.test.ts", "apps/api/**/*.test.ts", "apps/cli/**/*.test.ts"]
  }
});
