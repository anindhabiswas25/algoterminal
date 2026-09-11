import path from "node:path";
import type { NextConfig } from "next";

/**
 * `turbopack.root` is pinned to this directory because the repository holds two
 * lockfiles — the API at the root and this app here. Without it Next walks up,
 * finds the API's lockfile first and treats the repository root as the
 * workspace, which puts the build's module resolution in the wrong place.
 */
const nextConfig: NextConfig = {
  turbopack: { root: path.resolve(import.meta.dirname) },
};

export default nextConfig;
