/** @type {import('next').NextConfig} */
const nextConfig = {
  // Blue/green deploys (deploy/deploy.sh) build each release into its own
  // dist dir (.next-blue / .next-green) so a build never rewrites the
  // artifacts the live server is still serving (the ChunkLoadError failure
  // mode). `next start` reads the same env var. Defaults to .next so the
  // legacy legacy-single-process.sh path keeps working unchanged.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb"
    }
  },
  // EXPERIMENT (NEXT_SKIP_FILE_TRACE=1): drop Next's output-file-tracing plugin.
  // A build trace showed node-file-trace-plugin taking 668s of a 776s build
  // (86%) over 186 route entrypoints, and no cache touches it. Its only output
  // is .nft.json metadata consumed by `output: "standalone"` / serverless — this
  // deployment runs plain `next start` with node_modules on disk, so it is dead
  // weight. MUST be revisited before ever switching to standalone output.
  webpack: (config) => {
    if (process.env.NEXT_SKIP_FILE_TRACE === "1") {
      config.plugins = config.plugins.filter(
        (p) => p?.constructor?.name !== "TraceEntryPointsPlugin"
      );
    }
    return config;
  }
};

export default nextConfig;
