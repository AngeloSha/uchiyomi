/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
  trailingSlash: true,
  // The BFF is reached same-origin via NPM path routing (/api, /auth, /img).
};

export default nextConfig;
