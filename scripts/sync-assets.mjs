#!/usr/bin/env node
// Copies the UI from web/ (the source you edit) into public/ (what Workers
// static assets actually serves). Kept as a separate build step, rather
// than pointing wrangler.jsonc's assets.directory straight at web/, so
// public/ can stay a plain, disposable build output. Run via
// `npm run sync-assets` (wired into predev/predeploy).

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const sourceRoot = join(root, "web");
const publicDir = join(root, "public");

const copies = [
  // [source relative to web/, dest relative to public/]
  ["index.html", "index.html"],
  ["manifest.webmanifest", "manifest.webmanifest"],
  ["sw.js", "sw.js"],
  ["font.woff2", "font.woff2"],
  ["icons/logo.svg", "icons/logo.svg"],
  ["icons/icon-192.png", "icons/icon-192.png"],
  ["icons/icon-512.png", "icons/icon-512.png"],
  ["icons/icon-512-maskable.png", "icons/icon-512-maskable.png"],
  ["icons/apple-touch-icon.png", "icons/apple-touch-icon.png"],
];

let missing = 0;
for (const [from, to] of copies) {
  const src = join(sourceRoot, from);
  const dest = join(publicDir, to);
  if (!existsSync(src)) {
    console.error(`missing source file: ${src}`);
    missing++;
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

if (missing > 0) {
  console.error(`sync-assets: ${missing} source file(s) missing under web/`);
  process.exit(1);
}

console.log(`sync-assets: copied ${copies.length} file(s) from web/ to public/`);
