import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  /* config options here */
};

// Mounts the eve agent in ./agent at /eve/v1/* — one dev server, one deploy.
export default withEve(nextConfig);
