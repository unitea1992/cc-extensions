#!/usr/bin/env node
import fs from "node:fs";
import { preToolDecision } from "./decision-router.mjs";

try {
  const raw = fs.readFileSync(0, "utf8");
  if (raw.length > 1_000_000) process.exit(0);
  const result = preToolDecision(JSON.parse(raw));
  if (result) console.log(JSON.stringify(result));
} catch {
  // The router is advisory: malformed hook input never blocks an existing dispatch.
}
