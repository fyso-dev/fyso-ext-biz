import { defineConfig, devices } from "@playwright/test";

// One worker, ordered files: the sweep is a story (admin publishes, member connects, ...), not independent tests.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    locale: "en-US",
    // Traces record typed values (credentials): never on. Screenshots only on failure, in the run's artifacts.
    trace: "off",
    screenshot: "only-on-failure",
  },
});
