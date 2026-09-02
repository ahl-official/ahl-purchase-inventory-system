import type { NextConfig } from "next";

// next-pwa v5 is CommonJS-only with no type definitions, so it can't be a static import here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const withPWA = require("next-pwa")({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
  skipWaiting: true,
});

const nextConfig: NextConfig = {
  // Other Next.js config
  turbopack: {},
};

export default withPWA(nextConfig);
