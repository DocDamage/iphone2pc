import { build } from "esbuild";

await build({
  entryPoints: ["scripts/mobile-crypto-entry.ts"],
  outfile: "public/mobile/mobile-crypto.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["safari16"],
  minify: true,
  legalComments: "none"
});
