import type { NextConfig } from "next";

// The portal is a thin UI over the existing Bun/Hono API on :3044. Proxying
// same-origin here avoids CORS and keeps one host in the browser. The backend
// URL is overridable for other environments.
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3044";

const nextConfig: NextConfig = {
  turbopack: { root: __dirname },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${BACKEND}/api/:path*` },
      { source: "/skills/:path*", destination: `${BACKEND}/skills/:path*` },
      { source: "/llms.txt", destination: `${BACKEND}/llms.txt` },
      { source: "/.well-known/:path*", destination: `${BACKEND}/.well-known/:path*` },
    ];
  },
};

export default nextConfig;
