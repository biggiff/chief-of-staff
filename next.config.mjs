import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the workspace root so Next doesn't pick up an unrelated parent lockfile.
  outputFileTracingRoot: __dirname,
  // PGlite ships a WASM blob; keep it out of the bundler and load it at runtime.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
