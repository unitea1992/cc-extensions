import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TTL_MS = 30 * 60_000;
// The local d1 server runs with a 4096-token context. Measured Japanese text is about 0.73
// tokens per character and the fixed prompt costs roughly 300 tokens, so 3000 characters
// leave headroom instead of failing open on a long instruction.
const MAX_TASK_LENGTH = 3_000;
const MAX_SPEC_BYTES = 64_000;
const KINDS = new Set(["routine", "implementation", "investigation", "visual", "critical"]);
const EFFORTS = new Set(["low", "medium", "high"]);
const RISKS = new Set(["low", "medium", "high"]);
const AGENTS = new Set(["pi", "codex", "claude"]);

function adviceFields(result) {
  if (!result || typeof result !== "object") return null;
  if (!KINDS.has(result.kind) || !EFFORTS.has(result.effort) || !RISKS.has(result.risk)) return null;
  if (!AGENTS.has(result.suggested_agent)) return null;
  return {
    kind: result.kind, suggested_agent: result.suggested_agent,
    effort: result.effort, risk: result.risk
  };
}

function adviceOf(result) {
  return result && result.ok === true ? adviceFields(result) : null;
}

// Shell separators inside quotes belong to an argument, not to a new command.
function splitSegments(command) {
  const segments = [];
  let current = "", quote = null, escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { current += ch; escaped = true; continue; }
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { current += ch; quote = ch; continue; }
    const pair = (ch === "&" || ch === "|") && command[i + 1] === ch;
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      segments.push(current);
      current = "";
      if (pair) i += 1;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

// Only match an executable at the start of a shell segment; never execute shell text.
export function parseInvocation(command) {
  if (typeof command !== "string" || command.length > 100_000) return null;
  for (const segment of splitSegments(command)) {
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

function taskParts(invocation, cwd) {
  const parts = [invocation.title, invocation.reason].filter(Boolean);
  let truncated = false, omitted = false;
  for (const item of invocation.specFiles) {
    try {
      const file = path.resolve(cwd, item);
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_SPEC_BYTES) { omitted = true; continue; }
      const text = fs.readFileSync(file, "utf8").trim();
      if (!text) { omitted = true; continue; }
      if (text.length > MAX_TASK_LENGTH) truncated = true;
      parts.push(text.slice(0, MAX_TASK_LENGTH));
    } catch { omitted = true; }
  }
  if (invocation.task) parts.push("Task ID: " + invocation.task);
  if (invocation.followup) parts.push("Follow-up of: " + invocation.followup);
  return { parts, truncated, omitted };
}

export function summarizeTask(invocation, cwd) {
  return taskParts(invocation, cwd).parts.join("\n\n").slice(0, MAX_TASK_LENGTH);
}

function summarizeWithMeta(invocation, cwd) {
  const { parts, truncated, omitted } = taskParts(invocation, cwd);
  const text = parts.join("\n\n");
  return {
    text: text.slice(0, MAX_TASK_LENGTH), omitted,
    truncated: truncated || text.length > MAX_TASK_LENGTH
  };
}

function specFingerprint(file, cwd) {
  try {
    const target = path.resolve(cwd, file);
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > MAX_SPEC_BYTES) return "skipped";
    return createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  } catch { return "unreadable"; }
}

export function dispatchKey(event, invocation) {
  const cwd = event.cwd ?? "";
  const stable = [event.session_id ?? "unknown", cwd, invocation.name,
    invocation.task, invocation.followup, invocation.title ?? null, invocation.reason ?? null,
    ...invocation.specFiles.map((file) => file + ":" + specFingerprint(file, cwd))];
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function cachePath(key, env) {
  return path.join(env.DECISION_ROUTER_CACHE_DIR ||
    path.join(os.homedir(), ".cache", "cc-extensions", "decision-router"), key + ".json");
}
export function readCache(key, env = process.env) {
  try {
    const record = JSON.parse(fs.readFileSync(cachePath(key, env), "utf8"));
    return record.when > Date.now() - TTL_MS && record.when <= Date.now() + 60_000 &&
      adviceFields(record.advice) ? record : null;
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
  return classify(task, env, 4, 5_500, 256_000);
}

function classify(task, env, timeoutSeconds, spawnTimeoutMs, maxBuffer) {
  const bin = env.DECISION_ROUTER_PROVIDER_BIN || "d1-route";
  const run = spawnSync(bin, ["--task", task, "--strict", "--timeout", String(timeoutSeconds)],
    { encoding: "utf8", timeout: spawnTimeoutMs, env, maxBuffer, windowsHide: true });
  if (run.error || run.status !== 0) return null;
  try { return adviceOf(JSON.parse(run.stdout)); } catch { return null; }
}

export function preToolDecision(event, env = process.env) {
  if (event.tool_name !== "Bash") return null;
  const invocation = parseInvocation(event.tool_input?.command);
  if (!invocation) return null;
  const key = dispatchKey(event, invocation);
  if (readCache(key, env)) return null;
  const summary = summarizeWithMeta(invocation, event.cwd || process.cwd());
  if (!summary.text) return null;
  const advice = routeTask(summary.text, env);
  if (!advice) return null;
  if (summary.truncated || summary.omitted) {
    if (advice.risk === "low") advice.risk = "medium";
  }
  try { writeCache(key, { when: Date.now(), advice }, env); }
  catch { return null; }
  const verdict = "kind=" + advice.kind + ", suggested_agent=" + advice.suggested_agent +
    ", effort=" + advice.effort + ", risk=" + advice.risk +
    (summary.truncated ? ", input_truncated=true" : "") +
    (summary.omitted ? ", input_incomplete=true" : "");
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "decision-router: 自動判定を実施しました (" + verdict +
        ")。これは提案であり承認ではありません。ユーザー指定、最新の利用枠、agent-model-check、orca-worker-startの安全検査を優先し、必要なら引数を見直して同じDispatchを再実行してください。再実行では同じ判定を繰り返しません。" +
        (summary.truncated ? "入力は上限で切り詰めたため、末尾の条件は判定に含まれていません。" : "") +
        (summary.omitted ? "指示書の一部は読み取れないため、判定に含まれていません。" : "")
    }
  };
}

export function status(env = process.env) {
  const bin = env.DECISION_ROUTER_PROVIDER_BIN || "d1-route";
  const advice = classify("状態確認: 単純な文言修正", env, 2, 3_000, 16_000);
  return {
    plugin: "decision-router", provider: bin, ready: advice !== null,
    automaticTrigger: "PreToolUse Bash -> orca-worker-start", onUnavailable: "fail-open"
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === "decision-router.mjs" &&
    process.argv[2] === "status") {
  console.log(JSON.stringify(status()));
}
