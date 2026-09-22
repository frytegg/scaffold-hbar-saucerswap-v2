import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  reactStrictMode: true,
  devIndicators: false,
  // RainbowKit → wagmi → @base-org/account → @coinbase/cdp-sdk. From 1.53 the
  // SDK lazy-imports optional @x402/* peers; webpack still resolves those
  // specifiers and the production build fails if they are not installed.
  serverExternalPackages: ["@coinbase/cdp-sdk"],
  webpack: (config, { dev, webpack }) => {
    config.resolve.fallback = {
      fs: false,
      net: false,
      tls: false,
      "@x402/evm": false,
      "@x402/core": false,
    };
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^@x402\//,
      }),
    );
    // The UI kit's Balance and HbarInput fetch a USD price from CoinGecko in the browser and call
    // console.error when that fails. The kit offers no switch, so its price module is replaced with
    // one that reports "price unknown": no route contacts CoinGecko.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^\.\/hbarPrice$/, (resource: { context: string; request: string }) => {
        if (/@scaffold-hbar-ui[\\/]hooks[\\/]/.test(resource.context)) {
          resource.request = path.join(__dirname, "utils/scaffold-hbar/noHbarPrice.ts");
        }
      }),
    );
    config.externals.push("pino-pretty", "lokijs", "encoding");
    if (dev) {
      config.watchOptions = {
        followSymlinks: true,
      };
      config.snapshot = { ...(config.snapshot as object), managedPaths: [] };
    }
    return config;
  },
};

module.exports = nextConfig;
