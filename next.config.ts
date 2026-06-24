import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Suppress next-auth peer-dep warning in Next.js 15
  serverExternalPackages: ['googleapis'],
};

export default nextConfig;
