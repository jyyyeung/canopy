import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

/**
 * Copy assets that the bundle needs at runtime but esbuild doesn't
 * inline. Today it's just `pastel.css` — the dashboard controller
 * reads it off disk and inlines it into the panel's HTML so editing
 * the CSS doesn't require a webview rebuild. The file MUST live under
 * `dist/` because `.vscodeignore` excludes the whole `src/` tree from
 * the packaged .vsix.
 */
function copyAssets() {
  mkdirSync("dist/webview", { recursive: true });
  copyFileSync("src/webview/shared/pastel.css", "dist/webview/pastel.css");
}

/**
 * Two builds, in one config:
 *   1. extension.js — node, runs in the VS Code host. Imports `vscode`.
 *   2. webview/global-dashboard.js — browser, runs inside the dashboard
 *      panel's webview. Bundles React + the pastel CSS.
 *
 * Webview bundles target `es2020` because the webview's `<script>` runs in
 * VS Code's Electron renderer (recent Chromium). Extension stays on
 * `node18` to match the engines.vscode floor.
 */

const extension = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
};

const globalDashboard = {
  entryPoints: ["src/webview/global-dashboard/index.tsx"],
  bundle: true,
  outfile: "dist/webview/global-dashboard.js",
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
  jsx: "automatic",
  // React expects this — webview has no NODE_ENV otherwise.
  define: { "process.env.NODE_ENV": watch ? "\"development\"" : "\"production\"" },
};

if (watch) {
  const ctxs = await Promise.all([
    esbuild.context(extension),
    esbuild.context(globalDashboard),
  ]);
  await Promise.all(ctxs.map((c) => c.watch()));
  copyAssets();
} else {
  await Promise.all([
    esbuild.build(extension),
    esbuild.build(globalDashboard),
  ]);
  copyAssets();
}
