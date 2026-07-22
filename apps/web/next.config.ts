import type { NextConfig } from "next";

import { COMMON_SECURITY_RESPONSE_HEADERS } from "./src/http-security";

const webOrigin = process.env["WEB_ORIGIN"];

const nextConfig: NextConfig = {
  allowedDevOrigins: webOrigin === undefined ? [] : [new URL(webOrigin).hostname],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [...COMMON_SECURITY_RESPONSE_HEADERS],
      },
      {
        source: "/lobbies/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }],
      },
      {
        source: "/api/v1/lobbies/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }],
      },
    ];
  },
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
