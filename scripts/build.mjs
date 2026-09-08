#!/usr/bin/env node
import { build } from "esbuild";
import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
await mkdir(dist, { recursive: true });
for (const entry of await readdir(dist)) await rm(resolve(dist, entry), { recursive: true, force: true });
await build({ entryPoints: [resolve(root, "src/cli.ts")], outfile: resolve(dist, "cli.js"), bundle: true, platform: "node", format: "esm", target: "node24", packages: "bundle", legalComments: "inline" });
