// A stand-in `pi` executable. It speaks just enough of `pi --print --mode json` for the companion:
// it records every run (argv and stdin prompt) in a state file and answers with JSONL events.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export const FAKE_PI_MODELS = ["spark/Alpha-Flash", "spark/Beta-Next"];

export function installFakePi(binDir, behavior = "ok") {
  const statePath = path.join(binDir, "fake-pi-state.json");
  const scriptPath = path.join(binDir, "pi");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};
const MODELS = ${JSON.stringify(FAKE_PI_MODELS)};
const argv = process.argv.slice(2);

function loadState() {
  return fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : { runs: [] };
}

function valueOf(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
}

if (argv[0] === "--version") {
  console.log("1.1.0");
} else if (argv.includes("--help")) {
  console.log("pi - AI coding assistant\\n  --print, -p\\n  --mode <mode>\\n  --tools, -t <tools>");
} else if (argv.includes("--list-models")) {
  console.log("provider  model            context  max-out  thinking  images");
  for (const model of MODELS) {
    const [provider, name] = model.split("/");
    console.log(provider.padEnd(9) + " " + name.padEnd(16) + " 1M       32.8K    yes       yes");
  }
} else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    const state = loadState();
    const sessionId = valueOf("--session-id") || valueOf("--session") || "fake-session";
    state.runs.push({ argv, prompt, cwd: process.cwd(), sessionId });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));

    if (BEHAVIOR === "hang") {
      setInterval(() => {}, 1000);
      return;
    }
    if (BEHAVIOR === "fail") {
      process.stderr.write("Error: Model not found\\n");
      process.exit(1);
    }

    const emit = (event) => console.log(JSON.stringify(event));
    emit({ type: "session", version: 3, id: sessionId, cwd: process.cwd() });
    emit({ type: "agent_start" });
    if (BEHAVIOR === "edit") {
      emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "write", args: { path: "src/app.js", content: "x" } });
      emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "write", result: {}, isError: false });
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Calling the write tool." }], stopReason: "toolUse" } });
    }
    emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: prompt }] } });
    if (BEHAVIOR === "api-error") {
      emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider returned 500" } });
    } else {
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "considering" }, { type: "text", text: "Handled the requested task." }],
          stopReason: "stop"
        }
      });
    }
    emit({ type: "agent_settled", aborted: false });
  });
}
`;
  writeExecutable(scriptPath, source);
  return { statePath, scriptPath };
}

export function readFakePiState(binDir) {
  const statePath = path.join(binDir, "fake-pi-state.json");
  return fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { runs: [] };
}

export function buildPiEnv(binDir, extra = {}) {
  const sep = process.platform === "win32" ? ";" : ":";
  const env = { ...process.env, PATH: `${binDir}${sep}${process.env.PATH}`, ...extra };
  delete env.PI_COMPANION_BIN;
  return env;
}
