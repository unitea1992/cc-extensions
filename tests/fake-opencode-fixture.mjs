// Fake `opencode` executable for tests. It mirrors the OpenCode v2 CLI surface the companion uses:
// `--version`, `run --help`, `models`, `session list --format json`, and
// `run --standalone --format json` streaming one JSON event per line.
//
// Read-only enforcement is simulated with OpenCode's own permission semantics (last matching rule
// wins, `*` wildcards, trailing " *" means "optionally followed by arguments"), so tests exercise the
// exact ruleset the companion injects through OPENCODE_CONFIG_CONTENT.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export const FAKE_MODELS = ["fake/alpha", "fake/beta", "local/qwen"];

export function installFakeOpencode(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-opencode-state.json");
  const scriptPath = path.join(binDir, "opencode");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};
const MODELS = ${JSON.stringify(FAKE_MODELS)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { nextSessionId: 1, sessions: [], runs: [], modelCalls: 0 };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function emit(type, sessionID, data) {
  process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + "\\n");
}

function wildcardMatch(input, pattern) {
  let escaped = pattern.replace(/[.+^\${}()|[\\]\\\\]/g, "\\\\$&").replace(/\\*/g, ".*").replace(/\\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp("^" + escaped + "$", "s").test(input);
}

function evaluate(rules, action, resource) {
  const match = [...rules].reverse().find((rule) => wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource));
  return match ? match.effect : "ask";
}

// Approximates OpenCode's shell scanner: each simple command becomes one resource, redirections
// stay attached to their command, and command substitutions are scanned as commands too.
function scanShell(command) {
  const resources = [];
  const substitution = /\\$\\(([^()]*)\\)|\`([^\`]*)\`/g;
  let found;
  while ((found = substitution.exec(command)) !== null) {
    resources.push(...scanShell(found[1] ?? found[2]));
  }
  for (const part of command.split(/&&|\\|\\||;|\\|/)) {
    const trimmed = part.trim();
    if (trimmed) resources.push(trimmed);
  }
  return resources;
}

function agentRules(agent) {
  if (agent === "build") {
    return [{ action: "*", resource: "*", effect: "allow" }];
  }
  const content = process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : {};
  const configured = content.agents && content.agents[agent];
  if (!configured) {
    process.stderr.write("Agent not found: " + agent + "\\n");
    process.exit(1);
  }
  return configured.permissions || [];
}

function parseRunArgs(argv) {
  const options = { flags: [], message: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["--agent", "--model", "-m", "--session", "-s", "--title", "--format", "--file", "-f"].includes(arg)) {
      options[arg.replace(/^-+/, "")] = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--")) {
      options.flags.push(arg);
    } else {
      options.message.push(arg);
    }
  }
  return options;
}

function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function reviewPayload(prompt) {
  if (BEHAVIOR === "invalid-json") return "not valid json";
  if (BEHAVIOR === "schema-mismatch") {
    return JSON.stringify({ verdict: "approve", summary: "Looks fine.", findings: [], next_steps: [], extra: true });
  }
  const adversarial = prompt.includes("adversarial software review");
  const data =
    BEHAVIOR === "review-findings" || (adversarial && BEHAVIOR !== "adversarial-clean")
      ? {
          verdict: "needs-attention",
          summary: "One adversarial concern surfaced.",
          findings: [
            {
              severity: "high",
              title: "Missing empty-state guard",
              body: "The change assumes data is always present.",
              file: "src/app.js",
              line_start: 4,
              line_end: 6,
              confidence: 0.87,
              recommendation: "Handle empty collections before indexing."
            }
          ],
          next_steps: ["Add an empty-state test."]
        }
      : {
          verdict: "approve",
          summary: "No material issues found.",
          findings: [],
          next_steps: []
        };
  const json = JSON.stringify(data, null, 2);
  return BEHAVIOR === "fenced-json" ? "Here is the review:\\n\\n\`\`\`json\\n" + json + "\\n\`\`\`\\n" : json;
}

function stopGatePayload() {
  if (BEHAVIOR === "stop-block") return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  if (BEHAVIOR === "stop-decorated") return "**ALLOW:** No blocking issues found in the previous turn.";
  return "ALLOW: No blocking issues found in the previous turn.";
}

// Each "TOOL <name> <argument>" line in the prompt is attempted with the agent's permissions.
function attemptTools(sessionID, rules, prompt, cwd) {
  const outcomes = [];
  for (const line of prompt.split("\\n")) {
    const match = /^TOOL (\\w+) (.+)$/.exec(line.trim());
    if (!match) continue;
    const [, tool, argument] = match;
    let input;
    let allowed;
    if (tool === "shell") {
      input = { command: argument };
      allowed = scanShell(argument).every((resource) => evaluate(rules, "shell", resource) === "allow");
    } else if (tool === "write" || tool === "edit") {
      input = { filePath: path.resolve(cwd, argument) };
      allowed = evaluate(rules, "edit", input.filePath) === "allow";
    } else {
      input = { filePath: path.resolve(cwd, argument) };
      allowed = evaluate(rules, tool, input.filePath) === "allow";
    }
    let output = "";
    if (allowed) {
      if (tool === "shell") {
        const result = spawnSync("sh", ["-c", argument], { cwd, encoding: "utf8" });
        output = (result.stdout || "") + (result.stderr || "");
      } else if (tool === "write" || tool === "edit") {
        fs.writeFileSync(input.filePath, "written by fake opencode\\n");
        output = "Wrote " + input.filePath;
      } else if (tool === "read") {
        output = fs.readFileSync(input.filePath, "utf8");
      }
    }
    emit("tool_use", sessionID, {
      part: {
        sessionID,
        messageID: "msg_tools",
        type: "tool",
        tool,
        state: allowed
          ? { status: "completed", input, output }
          : { status: "error", input, error: "Permission denied: " + (tool === "write" ? "edit" : tool) }
      }
    });
    outcomes.push(tool + " " + argument + " => " + (allowed ? "allowed" : "denied"));
  }
  return outcomes;
}

function finish(state, sessionID, text, options = {}) {
  if (options.reasoning) {
    emit("reasoning", sessionID, { part: { sessionID, messageID: "msg_final", type: "reasoning", text: options.reasoning } });
  }
  emit("step_start", sessionID, { part: { sessionID, messageID: "msg_final", type: "step-start" } });
  emit("text", sessionID, { part: { sessionID, messageID: "msg_final", type: "text", text } });
  emit("step_finish", sessionID, { part: { sessionID, messageID: "msg_final", type: "step-finish", reason: "stop" } });
}

async function handleRun(argv) {
  const stdinPrompt = await readStdin();
  const state = loadState();
  const options = parseRunArgs(argv);
  const prompt = [options.message.join(" "), stdinPrompt].filter(Boolean).join("\\n");
  const cwd = process.cwd();

  let session = options.session ? state.sessions.find((entry) => entry.id === options.session) : null;
  if (!session) {
    session = {
      id: options.session || "ses_fake" + String(state.nextSessionId++).padStart(4, "0"),
      title: options.title || "Untitled session",
      directory: cwd,
      created: Date.now(),
      updated: Date.now()
    };
    state.sessions.push(session);
  }
  session.updated = Date.now();
  const sessionID = session.id;

  let configContent = null;
  try {
    configContent = process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : null;
  } catch {
    configContent = "invalid";
  }
  const run = {
    argv,
    agent: options.agent ?? null,
    model: options.model ?? null,
    session: options.session ?? null,
    title: options.title ?? null,
    flags: options.flags,
    prompt,
    cwd,
    configContent,
    pid: process.pid
  };
  state.runs.push(run);
  state.lastRun = run;
  saveState(state);

  const rules = agentRules(options.agent || "build");

  if (BEHAVIOR === "run-error") {
    emit("error", sessionID, { error: { name: "ProviderAuthError", message: "Provider rejected the request: invalid API key." } });
    process.exit(1);
  }
  if (BEHAVIOR === "crash") {
    process.stderr.write("fatal: fake opencode crashed\\n");
    process.exit(3);
  }

  const outcomes = attemptTools(sessionID, rules, prompt, cwd);
  if (BEHAVIOR === "write-edit") {
    const target = path.join(cwd, "src", "fixed.js");
    if (evaluate(rules, "edit", target) === "allow") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "export const fixed = true;\\n");
      emit("tool_use", sessionID, {
        part: { sessionID, messageID: "msg_tools", type: "tool", tool: "write", state: { status: "completed", input: { filePath: target }, output: "ok" } }
      });
    }
  }

  let text;
  if (prompt.includes("Run a stop-gate review of the previous Claude turn.")) {
    text = stopGatePayload();
  } else if (prompt.includes("<structured_output_contract>")) {
    text = reviewPayload(prompt);
  } else if (outcomes.length > 0) {
    text = "Tool outcomes:\\n" + outcomes.join("\\n");
  } else if (options.session) {
    text = "Resumed the prior run.\\nFollow-up prompt accepted.";
  } else {
    text = "Handled the requested task.\\nTask prompt accepted.";
  }

  const reasoning = BEHAVIOR === "with-reasoning" ? "Inspected the prompt, gathered evidence, and checked the highest-risk paths first." : null;
  const delay = BEHAVIOR === "slow-task" ? 400 : BEHAVIOR === "interruptible-slow-task" ? 30000 : 0;
  if (delay > 0) {
    emit("step_start", sessionID, { part: { sessionID, messageID: "msg_wait", type: "step-start" } });
    setTimeout(() => finish(state, sessionID, text, { reasoning }), delay);
    return;
  }
  finish(state, sessionID, text, { reasoning });
}

const argv = process.argv.slice(2);
if (argv[0] === "--version" || argv[0] === "-v") {
  process.stdout.write(BEHAVIOR === "v1-cli" ? "1.4.0\\n" : "opencode v2.0.20 (fake)\\n");
} else if (argv[0] === "run" && argv.includes("--help")) {
  process.stdout.write(
    BEHAVIOR === "v1-cli"
      ? "opencode run [message..]\\n  --model\\n  --session\\n"
      : "USAGE\\n  opencode run [flags] [<message...>]\\nFLAGS\\n  --standalone\\n  --session, -s string\\n  --model, -m string\\n  --agent string\\n  --format choice\\n  --title string\\n  --thinking\\n"
  );
} else if (argv[0] === "models") {
  const state = loadState();
  state.modelCalls += 1;
  saveState(state);
  if (BEHAVIOR !== "no-models" && !(BEHAVIOR === "cold-models" && state.modelCalls === 1)) {
    process.stdout.write(MODELS.join("\\n") + "\\n");
  }
} else if (argv[0] === "debug" && argv[1] === "config" && BEHAVIOR === "default-model") {
  // Sources are listed from lowest to highest precedence, as \`opencode debug config\` does.
  const sources = [
    {
      type: "document",
      path: "/home/user/.config/opencode/opencode.json",
      info: {
        model: { providerID: "local", model: "qwen" },
        providers: { local: { name: "Local", package: "aisdk:@ai-sdk/openai-compatible", settings: { apiKey: "***" }, models: { qwen: {} } } }
      }
    },
    { type: "directory", path: "/home/user/.config/opencode" },
    {
      type: "document",
      path: process.cwd() + "/opencode.json",
      info: { model: { providerID: "lan", model: "big" }, providers: { lan: { models: { big: {} } } } }
    }
  ];
  process.stdout.write(JSON.stringify(sources, null, 2) + "\\n");
} else if (argv[0] === "session" && argv[1] === "list") {
  const state = loadState();
  const sessions = [...state.sessions]
    .sort((left, right) => right.updated - left.updated)
    .map((session) => ({ id: session.id, title: session.title, updated: session.updated, created: session.created, projectId: "global", directory: session.directory }));
  process.stdout.write(JSON.stringify(sessions, null, 2) + "\\n");
} else if (argv[0] === "run") {
  handleRun(argv.slice(1));
} else {
  process.stderr.write("Unknown fake opencode command: " + argv.join(" ") + "\\n");
  process.exit(2);
}
`;
  writeExecutable(scriptPath, source);

  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "opencode.cmd"), `@echo off\r\nnode "%~dp0opencode" %*\r\n`, { encoding: "utf8" });
  }
  return { statePath, scriptPath };
}

export function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-opencode-state.json"), "utf8"));
}

export function buildEnv(binDir, extra = {}) {
  const sep = process.platform === "win32" ? ";" : ":";
  const env = {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`,
    ...extra
  };
  delete env.OPENCODE_CONFIG_CONTENT;
  delete env.OPENCODE_COMPANION_BIN;
  return env;
}
