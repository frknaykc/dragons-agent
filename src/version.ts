#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { version?: unknown };

if (typeof packageMetadata.version !== "string" || !packageMetadata.version.trim()) {
  throw new Error("Dragons package version is missing.");
}

/** The installed package manifest is the single authoritative version source. */
export const DRAGONS_VERSION = packageMetadata.version;
