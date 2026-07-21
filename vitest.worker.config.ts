import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["apps/api/**/*.worker.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./apps/api/wrangler.test.jsonc" }
      }
    }
  }
});
