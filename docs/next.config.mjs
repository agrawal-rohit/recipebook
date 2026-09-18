import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX({
  agentRules: false,
});

const root = path.dirname(fileURLToPath(import.meta.url));
const shimFs = path.join(root, "lib/viz/shims/fs.ts");
const shimPath = path.join(root, "lib/viz/shims/path.ts");
const shimNet = path.join(root, "lib/viz/shims/net.ts");

/** Relative from docs/ so Turbopack does not prepend `./` to an absolute path. */
const turbopackShims = {
  "node:fs": "./lib/viz/shims/fs.ts",
  "node:fs/promises": "./lib/viz/shims/fs.ts",
  "node:path": "./lib/viz/shims/path.ts",
  "node:net": "./lib/viz/shims/net.ts",
  fs: "./lib/viz/shims/fs.ts",
  path: "./lib/viz/shims/path.ts",
  net: "./lib/viz/shims/net.ts",
};

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  transpilePackages: ["@cheetos/core"],
  serverExternalPackages: ["esbuild"],
  async redirects() {
    return [
      {
        source: "/internal/viz",
        destination: "/simulator",
        permanent: true,
      },
    ];
  },
  turbopack: {
    resolveAlias: turbopackShims,
  },
  webpack: (webpackConfig) => {
    webpackConfig.resolve.alias = {
      ...webpackConfig.resolve.alias,
      "node:fs": shimFs,
      "node:fs/promises": shimFs,
      "node:path": shimPath,
      "node:net": shimNet,
      fs: shimFs,
      path: shimPath,
      net: shimNet,
    };
    return webpackConfig;
  },
};

export default withMDX(config);
