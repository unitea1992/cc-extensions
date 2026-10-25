// A stand-in `dst` executable. It speaks just enough of `dst run --json` and
// `dst models list --json` for the companion: it records every run (argv, the stdin prompt, and
// the DSH_LAUNCH_* environment the companion set) in a state file and answers with one line of
// JSON in the shape real `dst --json` runs print (schemaVersion 1, ok, sessionId, text, error).
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export const FAKE_DST_MODELS = ["logfare/glm-5.3", "logfare/glm-5.3-flash", "openrouter/minimax/m3.1:free"];

export function installFakeDst(binDir, behavior = "ok") {
  const statePath = path.join(binDir, "fake-dst-state.json");
  const scriptPath = path.join(binDir, "dst");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};
const MODELS = ${JSON.stringify(FAKE_DST_MODELS)};
const argv = process.argv.slice(2);

function loadState() {
  return fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : { runs: [] };
}

function valueOf(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
}

if (argv[0] === "--version") {
  console.log("dst 0.17.0 (launcher)");
} else if (argv[0] === "run" && argv.includes("--help")) {
  console.log("usage: dst run [options] [--] [prompt...]");
  console.log("  --profile NAME  --patch FILE  --json  --session-id ID");
  console.log("  --provider ID --model ID  --permission-mode MODE  --timeout MS");
} else if (argv[0] === "models" && argv[1] === "list") {
  if (BEHAVIOR === "no-profile" && argv.includes("--profile")) {
    console.log(JSON.stringify({ schemaVersion: 1, type: "result", ok: false, error: { code: "PROVIDER_NOT_FOUND", message: "DSH could not complete the requested operation" }, exitCode: 3 }));
    process.exit(3);
  }
  const providers = new Map();
  for (const model of MODELS) {
    const separator = model.indexOf("/");
    const provider = model.slice(0, separator);
    if (!providers.has(provider)) {
      providers.set(provider, []);
    }
    providers.get(provider).push({ id: model.slice(separator + 1), name: model.slice(separator + 1) });
  }
  const data = [...providers.entries()].map(([provider, models]) => ({ provider, models }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "result", ok: true, data }));
} else if (argv[0] === "run") {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    const state = loadState();
    const sessionId = valueOf("--session-id") || "session-fake-" + (state.runs.length + 1);
    state.runs.push({
      argv,
      prompt,
      cwd: process.cwd(),
      sessionId,
      launch: {
        provider: process.env.DSH_LAUNCH_PROVIDER || null,
        model: process.env.DSH_LAUNCH_MODEL || null,
        effort: process.env.DSH_LAUNCH_EFFORT || null
      }
    });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));

    if (BEHAVIOR === "hang") {
      setInterval(() => {}, 1000);
      return;
    }
    if (BEHAVIOR === "exit1") {
      process.stderr.write("Error: Model not found\\n");
      process.exit(1);
    }
    if (BEHAVIOR === "deadline") {
      process.stderr.write("Error: deadline exceeded\\n");
      process.exit(124);
    }
    if (BEHAVIOR === "fail") {
      console.log(JSON.stringify({
        schemaVersion: 1,
        type: "result",
        ok: false,
        error: { code: "TASK_FAILED", message: "boom from the fake provider" },
        exitCode: 1
      }));
      process.exit(1);
    }

    console.log(JSON.stringify({ schemaVersion: 1, type: "result", ok: true, sessionId, text: "Handled the requested task." }));
  });
} else {
  process.stderr.write("unknown command\\n");
  process.exit(2);
}
`;
  writeExecutable(scriptPath, source);
  return { statePath, scriptPath };
}

export function readFakeDstState(binDir) {
  const statePath = path.join(binDir, "fake-dst-state.json");
  return fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { runs: [] };
}

export function buildDstEnv(binDir, extra = {}) {
  const sep = process.platform === "win32" ? ";" : ":";
  const env = { ...process.env, PATH: `${binDir}${sep}${process.env.PATH}`, ...extra };
  delete env.DSH_COMPANION_BIN;
  return env;
}
