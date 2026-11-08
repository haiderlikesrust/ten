/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ["@gemdex/core"],
  // Always defined, so webpack sees an empty string and drops the wallet code from paper builds.
  env: { NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "" },
  // Set per build by the Dockerfile. A browser still running the previous build reloads on its next
  // navigation instead of mixing old and new code.
  deploymentId: process.env.NEXT_DEPLOYMENT_ID || undefined,
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  allowedDevOrigins: ["127.0.0.1"],
  // Card photos are resized to the size on screen. The widths match src/lib/image.ts.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "d1xpxki1g4htqu.cloudfront.net" },
      { protocol: "https", hostname: "degwuxynwtb2zaso.public.blob.vercel-storage.com" },
    ],
    imageSizes: [64, 96, 128, 256, 384],
    deviceSizes: [640, 828],
    formats: ["image/webp"],
    minimumCacheTTL: 86400,
  },
  async redirects() {
    return [
      { source: "/flywheel", destination: "/treasury", permanent: true },
      // Auto-Buy was removed. Old links land on Pulse, where limit orders live.
      { source: "/auto", destination: "/", permanent: true },
    ];
  },
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    }];
  },
};
export default config;
