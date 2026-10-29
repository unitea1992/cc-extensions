import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TTL_MS = 30 * 60_000;
const MAX_TASK_LENGTH = 14_000;
const MAX_SPEC_BYTES = 64_000;
const KINDS = new Set(["routine", "implementation", "investigation", "visual", "critical"]);
const EFFORTS = new Set(["low", "medium", "high"]);
const RISKS = new Set(["low", "medium", "high"]);

// Only match an executable at the start of a shell segment; never execute shell text.
export function parseInvocation(command) {
  if (typeof command !== "string" || command.length > 100_000) return null;
  for (const segment of command.split(/(?:&&|\|\||;|\n)/)) {
    const text = segment.trim();
    const match = /^(?:(?:[a-zA-Z_]\w*=\S+|env|timeout\s+\d+[smhd]?|command)\s+)*(?:(?:\/[^\s]+\/)?orca-worker-start)(?=\s|$)/.exec(text);
    if (!match) continue;
    const args = tokenize(text.slice(match[0].length));
    if (!args || args.includes("--help") || args.includes("-h")) return null;
    const options = {
      name: option(args, "--name"),
      task: option(args, "--task"),
      followup: option(args, "--followup-of"),
      specFiles: allOptions(args, "--spec-file"),
      reason: option(args, "--reason"),
      title: option(args, "--title")
    };
    if (!options.name && !options.task && !options.followup) return null;
    return options;
  }
  return null;
}

function tokenize(input) {
  const words = [];
  let current = "", quote = null, escaped = false, started = false;
  for (const ch of input) {
    if (escaped) { current += ch; escaped = false; started = true; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { words.push(current); current = ""; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (escaped || quote) return null;
  if (started) words.push(current);
  return words;
}

function allOptions(args, flag) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) result.push(args[++i]);
    else if (args[i].startsWith(flag + "=")) result.push(args[i].slice(flag.length + 1));
  }
  return result;
}
function option(args, flag) { return allOptions(args, flag)[0] ?? null; }

export function summarizeTask(invocation, cwd) {
  const parts = [invocation.title, invocation.reason].filter(Boolean);
  for (const item of invocation.specFiles) {
    try {
      const file = path.resolve(cwd, item);
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_SPEC_BYTES) continue;
      const text = fs.readFileSync(file, "utf8").trim();
      if (text) parts.push(text.slice(0, MAX_TASK_LENGTH));
    } catch { /* A missing file is not a dispatch failure. */ }
  }
  if (invocation.task) parts.push("Task ID: " + invocation.task);
  if (invocation.followup) parts.push("Follow-up of: " + invocation.followup);
  return parts.join("\n\n").slice(0, MAX_TASK_LENGTH);
}

export function dispatchKey(event, invocation) {
  const stable = [event.session_id ?? "unknown", event.cwd ?? "", invocation.name,
    invocation.task, invocation.followup, ...invocation.specFiles];
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function cachePath(key, env) {
  return path.join(env.DECISION_ROUTER_CACHE_DIR ||
    path.join(os.homedir(), ".cache", "cc-extensions", "decision-router"), key + ".json");
}
export function readCache(key, env = process.env) {
  try {
    const record = JSON.parse(fs.readFileSync(cachePath(key, env), "utf8"));
    return record.when > Date.now() - TTL_MS && record.when <= Date.now() + 60_000 ? record : null;
  } catch { return null; }
}
export function writeCache(key, record, env = process.env) {
  const target = cachePath(key, env);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = target + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function routeTask(task, env = process.env) {
  const bin = env.DECISION_ROUTER_PROVIDER_BIN || "d1-route";
  const run = spawnSync(bin, ["--task", task, "--strict", "--timeout", "4"],
    { encoding: "utf8", timeout: 5_500, env, maxBuffer: 256_000, windowsHide: true });
  if (run.error || run.status !== 0) return null;
  try {
    const result = JSON.parse(run.stdout);
    if (result.ok === true && KINDS.has(result.kind) &&
        EFFORTS.has(result.effort) && RISKS.has(result.risk)) return result;
  } catch { /* Fail open on unexpected provider output. */ }
  return null;
}

export function preToolDecision(event, env = process.env) {
  if (event.tool_name !== "Bash") return null;
  const invocation = parseInvocation(event.tool_input?.command);
  if (!invocation) return null;
  const key = dispatchKey(event, invocation);
  if (readCache(key, env)) return null;
  const summary = summarizeTask(invocation, event.cwd || process.cwd());
  if (!summary) return null;
  const advice = routeTask(summary, env);
  if (!advice) return null;
  try { writeCache(key, { when: Date.now(), advice }, env); }
  catch { return null; }
  const verdict = "kind=" + advice.kind + ", suggested_agent=" + advice.suggested_agent +
    ", effort=" + advice.effort + ", risk=" + advice.risk;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "decision-router: 自動判定を実施しました (" + verdict +
        ")。これは提案であり承認ではありません。ユーザー指定、最新の利用枠、agent-model-check、orca-worker-startの安全検査を優先し、必要なら引数を見直して同じDispatchを再実行してください。再実行では同じ判定を繰り返しません。"
    }
  };
}

export function status(env = process.env) {
  const bin = env.DECISION_ROUTER_PROVIDER_BIN || "d1-route";
  const run = spawnSync(bin, ["--task", "状態確認: 単純な文言修正", "--strict", "--timeout", "2"],
    { encoding: "utf8", timeout: 3_000, env, maxBuffer: 16_000 });
  return {
    plugin: "decision-router", provider: bin, ready: !run.error && run.status === 0,
    automaticTrigger: "PreToolUse Bash -> orca-worker-start", onUnavailable: "fail-open"
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === "decision-router.mjs" &&
    process.argv[2] === "status") {
  console.log(JSON.stringify(status()));
}
