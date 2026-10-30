import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TTL_MS = 30 * 60_000;
// Measured against the local d1 server (llama-server --ctx-size 4096, one slot): /v1/systemone
// rejects a rendered prompt above the 512-token physical batch long before the 4096-token
// context, and d1-route's prefix plus template/questions take a measured 131 tokens. Only the
// remaining 357 tokens of task text fit, with margin for template or provider changes.
const PROMPT_TOKEN_LIMIT = 512;
const FIXED_PROMPT_TOKENS = 131;
const SAFETY_MARGIN_TOKENS = 24;
const MAX_TASK_TOKENS = PROMPT_TOKEN_LIMIT - FIXED_PROMPT_TOKENS - SAFETY_MARGIN_TOKENS;
const TRIM_MARKER = "\n…（中略）…\n";
const MAX_SPEC_BYTES = 64_000;
const DEFAULT_TOKENIZER_URL = "http://127.0.0.1:18991/tokenize";
const TOKENIZE_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "tokenize-count.mjs");
const KINDS = new Set(["routine", "implementation", "investigation", "visual", "critical"]);
const EFFORTS = new Set(["low", "medium", "high"]);
const RISKS = new Set(["low", "medium", "high"]);
const AGENTS = new Set(["pi", "codex", "claude"]);
const SHADOW_MAX_CANDIDATES = 8;
const SHADOW_TEXT_LIMIT = 2_000;
const SHADOW_SPAWN_TIMEOUT_MS = 2_000;
// hooks.json gives the hook 8 seconds; classification and trimming run before this budget.
const HOOK_BUDGET_MS = 7_000;
const SHADOW_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHADOW_PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const SHADOW_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,119}$/;
const SHADOW_CODE = /^[a-z][a-z0-9_]{0,47}$/;
// Deterministic floor for conditions that a trimmed middle could hide. It can only raise risk.
const HIGH_RISK_TERMS =
  /(本番|production|デプロイ|deploy|課金|billing|支払|決済|削除|delete|rm\s+-rf|DROP\s+TABLE|force\s+push|--force|reset\s+--hard|秘密|secret|パスワード|password|credential|api[_-]?key|個人情報|顧客データ|データ破壊|不可逆)/i;

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
  let omitted = false;
  for (const item of invocation.specFiles) {
    try {
      const file = path.resolve(cwd, item);
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_SPEC_BYTES) { omitted = true; continue; }
      const text = fs.readFileSync(file, "utf8").trim();
      if (!text) { omitted = true; continue; }
      parts.push(text);
    } catch { omitted = true; }
  }
  if (invocation.task) parts.push("Task ID: " + invocation.task);
  if (invocation.followup) parts.push("Follow-up of: " + invocation.followup);
  return { parts, omitted };
}

export function summarizeTask(invocation, cwd) {
  return taskParts(invocation, cwd).parts.join("\n\n");
}

function summarizeWithMeta(invocation, cwd) {
  const { parts, omitted } = taskParts(invocation, cwd);
  return { text: parts.join("\n\n"), omitted };
}

function localTokenizerUrl(env) {
  let parsed;
  try { parsed = new URL(env.DECISION_ROUTER_TOKENIZER_URL || DEFAULT_TOKENIZER_URL); }
  catch { return null; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return null;
  return parsed.href;
}

// The helper only talks to the local tokenizer endpoint; the task text never leaves the machine.
function countTokens(text, env) {
  const bin = env.DECISION_ROUTER_TOKENIZE_BIN;
  const url = localTokenizerUrl(env);
  if (!bin && !url) return null;
  const childEnv = { ...env };
  delete childEnv.NODE_OPTIONS;
  const run = spawnSync(bin || process.execPath, bin ? [] : [TOKENIZE_HELPER, url], {
    input: text, encoding: "utf8", timeout: 800, maxBuffer: 1_000_000, env: childEnv, windowsHide: true
  });
  if (run.error || run.status !== 0) return null;
  try {
    const tokens = JSON.parse(run.stdout).tokens;
    return Number.isInteger(tokens) && tokens >= 0 ? tokens : null;
  } catch { return null; }
}

function headTail(chars, keep) {
  const markerLength = Array.from(TRIM_MARKER).length;
  const body = Math.max(0, keep - markerLength);
  const headLength = Math.ceil(body * 0.6);
  const tailLength = body - headLength;
  const tail = tailLength > 0 ? chars.slice(chars.length - tailLength).join("") : "";
  return chars.slice(0, headLength).join("") + TRIM_MARKER + tail;
}

// A token covers at least one UTF-8 byte, so a byte cap is also a token cap when the
// tokenizer cannot be reached.
function fitByBytes(text) {
  const chars = Array.from(text);
  let low = 0, high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(headTail(chars, mid), "utf8") <= MAX_TASK_TOKENS) low = mid;
    else high = mid - 1;
  }
  return { text: headTail(chars, low), truncated: true };
}

export function fitToTokenBudget(text, env = process.env) {
  if (Buffer.byteLength(text, "utf8") <= MAX_TASK_TOKENS) return { text, truncated: false };
  const chars = Array.from(text);
  const total = countTokens(text, env);
  if (total === null) return fitByBytes(text);
  if (total <= MAX_TASK_TOKENS) return { text, truncated: false };
  let keep = Math.floor(chars.length * MAX_TASK_TOKENS / total);
  for (let attempt = 0; attempt < 3 && keep > 0; attempt += 1) {
    const candidate = headTail(chars, keep);
    const tokens = countTokens(candidate, env);
    if (tokens === null) return fitByBytes(text);
    if (tokens <= MAX_TASK_TOKENS) return { text: candidate, truncated: true };
    keep = Math.floor(keep * MAX_TASK_TOKENS / tokens);
  }
  return fitByBytes(text);
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
  return classify(task, env, 4, 5_500, 256_000).advice;
}

function classify(task, env, timeoutSeconds, spawnTimeoutMs, maxBuffer) {
  const bin = env.DECISION_ROUTER_PROVIDER_BIN || "d1-route";
  const run = spawnSync(bin, ["--task", task, "--strict", "--timeout", String(timeoutSeconds)],
    { encoding: "utf8", timeout: spawnTimeoutMs, env, maxBuffer, windowsHide: true });
  if (run.error) return { advice: null, missing: run.error.code === "ENOENT" };
  if (run.status !== 0) return { advice: null, missing: false };
  try { return { advice: adviceOf(JSON.parse(run.stdout)), missing: false }; }
  catch { return { advice: null, missing: false }; }
}

function failOpenNotice(trimmed) {
  return {
    systemMessage: "decision-router: ローカル判定を取得できませんでした。助言を出さず、既存のユーザー指定・agent-model-check・orca-worker-start の安全検査に従って起動してください（fail-open）。" +
      (trimmed ? "長い入力はトークン上限に合わせて切り詰めました。" : "")
  };
}

function shadowCodes(value) {
  if (!Array.isArray(value)) return null;
  const codes = [];
  for (const item of value) {
    if (typeof item !== "string" || !SHADOW_CODE.test(item)) return null;
    if (!codes.includes(item)) codes.push(item);
    if (codes.length === 8) break;
  }
  return codes;
}

function shadowCandidate(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const { id, provider, model, eligible } = item;
  if (typeof id !== "string" || !SHADOW_ID.test(id)) return null;
  if (typeof provider !== "string" || !SHADOW_PROVIDER.test(provider)) return null;
  if (typeof model !== "string" || !SHADOW_MODEL.test(model)) return null;
  if (typeof eligible !== "boolean") return null;
  const reasons = shadowCodes(item.reasons);
  const warnings = shadowCodes(item.warnings);
  if (!reasons || !warnings) return null;
  return { id, provider, model, eligible, reasons, warnings };
}

// Only the documented shadow contract is accepted; anything else is treated as unavailable.
export function parseShadowResult(stdout) {
  let result;
  try { result = JSON.parse(stdout); } catch { return null; }
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  if (result.mode !== "shadow" || result.advisory_only !== true || result.auto_launch !== false) return null;
  if (!Array.isArray(result.candidates)) return null;
  const reasons = shadowCodes(result.reasons);
  const warnings = shadowCodes(result.warnings);
  if (!reasons || !warnings) return null;
  const candidates = [];
  for (const item of result.candidates) {
    const candidate = shadowCandidate(item);
    if (!candidate) return null;
    candidates.push(candidate);
    if (candidates.length === SHADOW_MAX_CANDIDATES) break;
  }
  return { candidates, reasons, warnings };
}

function shadowText(result) {
  const eligible = result.candidates.filter((candidate) => candidate.eligible);
  const excluded = result.candidates.filter((candidate) => !candidate.eligible);
  const lines = ["候補評価（shadow・助言のみ。起動・モデル・費用は変えません）:"];
  if (!eligible.length) lines.push("- 適格な候補はありません。");
  for (const candidate of eligible) {
    lines.push("- " + candidate.provider + "/" + candidate.model + "（" + candidate.id + "）: 適格");
  }
  for (const candidate of excluded) {
    lines.push("- " + candidate.provider + "/" + candidate.model + "（" + candidate.id + "）: 対象外" +
      (candidate.reasons.length ? "（" + candidate.reasons.join(", ") + "）" : ""));
  }
  if (result.reasons.length) lines.push("不明・対象外の理由: " + result.reasons.join(", "));
  const warnings = result.warnings.filter((warning) => warning !== "shadow_only");
  if (warnings.length) lines.push("未確認: " + warnings.join(", "));
  lines.push("候補は提案であり、承認でも起動許可でもありません。");
  const text = lines.join("\n");
  return text.length > SHADOW_TEXT_LIMIT ? text.slice(0, SHADOW_TEXT_LIMIT) + "…" : text;
}

function shadowNotice(advice, context, env) {
  const bin = env.DECISION_ROUTER_SHADOW_ALLOCATOR;
  if (!bin) return null;
  if (!path.isAbsolute(bin)) {
    return "候補評価: 実行ファイルのパスが絶対パスではありません（shadow_allocator_invalid）。";
  }
  try {
    if (!fs.statSync(bin).isFile()) throw new Error("not a file");
  } catch {
    return "候補評価: 実行ファイルが見つかりません（shadow_allocator_missing）。";
  }
  if (context.truncated) {
    return "候補評価: 入力がトークン上限で切り詰められているため省略しました（input_truncated）。";
  }
  if (context.omitted) {
    return "候補評価: 指示書の一部が読めないため省略しました（input_incomplete）。";
  }
  if (advice.risk === "high") return null;
  if (context.remainingMs < 300) {
    return "候補評価: フックの時間予算が足りないため省略しました（shadow_no_time）。";
  }
  // Pass only the validated classification fields so task text and secrets never reach the tool.
  const classification = JSON.stringify({
    ok: true, kind: advice.kind, suggested_agent: advice.suggested_agent,
    effort: advice.effort, risk: advice.risk
  });
  const run = spawnSync(bin, ["--classification", classification, "--timeout", "1"], {
    encoding: "utf8", timeout: Math.min(SHADOW_SPAWN_TIMEOUT_MS, context.remainingMs),
    maxBuffer: 256_000, env, windowsHide: true
  });
  if (run.error || run.status !== 0) {
    const code = run.error?.code === "ETIMEDOUT" ? "shadow_timeout" : "shadow_unavailable";
    return "候補評価: 取得できませんでした（" + code + "）。上記の判定の助言はそのまま有効です。";
  }
  const result = parseShadowResult(run.stdout);
  if (!result) {
    return "候補評価: 応答が契約に合わないため表示しません（shadow_invalid_response）。上記の判定の助言はそのまま有効です。";
  }
  return shadowText(result);
}

export function preToolDecision(event, env = process.env) {
  const startedAt = Date.now();
  if (event.tool_name !== "Bash") return null;
  const invocation = parseInvocation(event.tool_input?.command);
  if (!invocation) return null;
  const key = dispatchKey(event, invocation);
  if (readCache(key, env)) return null;
  const summary = summarizeWithMeta(invocation, event.cwd || process.cwd());
  if (!summary.text.trim()) return null;
  const fitted = fitToTokenBudget(summary.text, env);
  const highRisk = HIGH_RISK_TERMS.test(summary.text);
  const outcome = classify(fitted.text, env, 4, 5_500, 256_000);
  if (!outcome.advice) {
    if (outcome.missing) return null;
    return failOpenNotice(fitted.truncated);
  }
  const advice = outcome.advice;
  if (advice.risk === "low" && (fitted.truncated || summary.omitted)) advice.risk = "medium";
  if (highRisk) advice.risk = "high";
  if (advice.risk === "high") advice.effort = "high";
  try { writeCache(key, { when: Date.now(), advice }, env); }
  catch { return null; }
  const verdict = "kind=" + advice.kind + ", suggested_agent=" + advice.suggested_agent +
    ", effort=" + advice.effort + ", risk=" + advice.risk +
    (highRisk ? ", high_risk_input=true" : "") +
    (fitted.truncated ? ", input_truncated=true" : "") +
    (summary.omitted ? ", input_incomplete=true" : "");
  const shadow = shadowNotice(advice, {
    truncated: fitted.truncated, omitted: summary.omitted,
    remainingMs: HOOK_BUDGET_MS - (Date.now() - startedAt)
  }, env);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "decision-router: 自動判定を実施しました (" + verdict +
        ")。これは提案であり承認ではありません。ユーザー指定、最新の利用枠、agent-model-check、orca-worker-startの安全検査を優先し、必要なら引数を見直して同じDispatchを再実行してください。再実行では同じ判定を繰り返しません。" +
        (fitted.truncated ? "入力は文字数ではなくトークン上限に合わせて先頭と末尾だけを渡したため、途中の条件は判定に含まれていません。" : "") +
        (summary.omitted ? "指示書の一部は読み取れないため、判定に含まれていません。" : "") +
        (shadow ? "\n" + shadow : "")
    }
  };
}

export function status(env = process.env) {
  const bin = env.DECISION_ROUTER_PROVIDER_BIN || "d1-route";
  const advice = classify("状態確認: 単純な文言修正", env, 2, 3_000, 16_000).advice;
  return {
    plugin: "decision-router", provider: bin, ready: advice !== null,
    automaticTrigger: "PreToolUse Bash -> orca-worker-start", onUnavailable: "fail-open"
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === "decision-router.mjs" &&
    process.argv[2] === "status") {
  console.log(JSON.stringify(status()));
}
