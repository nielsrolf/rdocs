import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: {
    // Run the production server (what actually deploys). `next dev`'s webpack
    // trips on node-only imports (node:child_process via research-workspace in
    // the instrumentation edge bundle); the prod build handles them correctly.
    command: "npm run build && npm run start -- --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 240_000
  },
  projects: [
    {
      name: "chromium",
      // Bundled Chromium (no dependency on a system Chrome install) so e2e runs
      // on CI and fresh dev machines.
      use: {
        ...devices["Desktop Chrome"],
        channel: undefined
      }
    }
  ]
});
