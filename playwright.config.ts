import { defineConfig, devices } from "@playwright/test";

/**
 * Points at the dev server that is already running (HANDOFF.md: port 3001 if
 * 3000 is taken; the live one during this session was on 3000). Does NOT
 * start its own server -- `npm run dev` must already be running, same as any
 * manual click-through.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // Generous: the live Apps Script endpoint has been observed taking up to
  // ~60s per call (cold starts, sheet scans), and this test chains ~8 of them.
  timeout: 8 * 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
