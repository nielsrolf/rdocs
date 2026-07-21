/** @type {import('next').NextConfig} */
const nextConfig = {
  // Blue/green deploys (deploy/deploy.sh) build each release into its own
  // dist dir (.next-blue / .next-green) so a build never rewrites the
  // artifacts the live server is still serving (the ChunkLoadError failure
  // mode). `next start` reads the same env var. Defaults to .next so the
  // legacy gdocs-ai.sh path keeps working unchanged.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb"
    }
  }
};

export default nextConfig;
