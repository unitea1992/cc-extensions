import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseInvocation, summarizeTask, fitToTokenBudget, dispatchKey, readCache, writeCache,
  routeTask, status, parseShadowResult
} from "../plugins/decision-router/scripts/decision-router.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "plugins/decision-router/scripts/pretool-hook.mjs");
const TRIM_MARKER = "…（中略）…";

function makeProvider(dir) {
  const bin = path.join(dir, "fake-d1-route");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
if (process.env.FAKE_CALLS) fs.appendFileSync(process.env.FAKE_CALLS, "call\\n");
if (process.env.FAKE_ARGV) fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify(argv));
if (process.env.FAKE_FAIL === "1") process.exit(1);
if (process.env.FAKE_SLEEP) { const end = Date.now() + Number(process.env.FAKE_SLEEP); while (Date.now() < end) {} }
const task = argv[argv.indexOf("--task") + 1];
const maxChars = Number(process.env.FAKE_MAX_TASK_CHARS || 0);
if (maxChars && Array.from(task).length > maxChars) {
  console.log(JSON.stringify({ ok: false, reason: "HTTPError" }));
  process.exit(1);
}
const mode = process.env.FAKE_MODE || "ok";
if (mode === "missing-agent") console.log(JSON.stringify({ ok: true, kind: "routine", effort: "low", risk: "low" }));
else if (mode === "bad-json") console.log("not json");
else if (mode === "unknown-kind") console.log(JSON.stringify({ ok: true, kind: "nope", effort: "low", risk: "low", suggested_agent: "pi" }));
else if (mode === "secret-agent") console.log(JSON.stringify({ ok: true, kind: "routine", effort: "low", risk: "low", suggested_agent: "SECRET_AGENT_123" }));
else if (mode === "newline-agent") console.log(JSON.stringify({ ok: true, kind: "routine", effort: "low", risk: "low", suggested_agent: "pi\\nSECRET" }));
else if (mode === "high-risk") console.log(JSON.stringify({ ok: true, kind: "critical", effort: "high", risk: "high", suggested_agent: "codex" }));
else if (mode === "echo-extra") console.log(JSON.stringify({ ok: true, kind: "routine", effort: "low", risk: "low", suggested_agent: "pi", model: null, reason: task, echo: task }));
else console.log(JSON.stringify({ ok: true, kind: "routine", effort: "low", risk: "low", suggested_agent: "pi", model: null }));
`, { mode: 0o755 });
  return bin;
}

function makeTokenizer(dir) {
  const bin = path.join(dir, "fake-tokenize");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
if (process.env.FAKE_TOKENIZE_CALLS) fs.appendFileSync(process.env.FAKE_TOKENIZE_CALLS, "call\\n");
if (process.env.FAKE_TOKENIZE_FAIL === "1") process.exit(1);
const text = fs.readFileSync(0, "utf8");
const ratio = Number(process.env.FAKE_TOKENIZE_RATIO || "0.55");
console.log(JSON.stringify({ tokens: Math.ceil(Array.from(text).length * ratio) }));
`, { mode: 0o755 });
  return bin;
}

function makeShadow(dir) {
  const bin = path.join(dir, "fake-shadow-allocate");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
if (process.env.FAKE_SHADOW_CALLS) fs.appendFileSync(process.env.FAKE_SHADOW_CALLS, "call\\n");
if (process.env.FAKE_SHADOW_ARGV) fs.writeFileSync(process.env.FAKE_SHADOW_ARGV, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_SHADOW_SLEEP) { const end = Date.now() + Number(process.env.FAKE_SHADOW_SLEEP); while (Date.now() < end) {} }
const mode = process.env.FAKE_SHADOW_MODE || "ok";
if (mode === "fail") process.exit(1);
if (mode === "bad-json") { console.log("not json"); process.exit(0); }
if (mode === "wrong-shape") { console.log(JSON.stringify({ mode: "shadow", advisory_only: true, auto_launch: true, candidates: [] })); process.exit(0); }
if (mode === "secret-id") { console.log(JSON.stringify({ mode: "shadow", advisory_only: true, auto_launch: false, candidates: [{ id: "bad\\nSECRET_MARKER_777", provider: "spark-local", model: "m", eligible: true, reasons: [], warnings: [] }], reasons: [], warnings: ["shadow_only"] })); process.exit(0); }
if (mode === "capacity") { console.log(JSON.stringify({ mode: "shadow", advisory_only: true, auto_launch: false, candidates: [], reasons: ["quota_observation_missing", "quota_not_assignable"], warnings: ["shadow_only", "metric_freshness_unconfirmed"] })); process.exit(0); }
console.log(JSON.stringify({ mode: "shadow", advisory_only: true, auto_launch: false, selection: "shadow_advisory", candidates: [
  { id: "spark-local-deepseek", provider: "spark-local", model: "DeepSeek-V4.1-Flash-1017", eligible: true, reasons: [], warnings: ["local_cache_unknown"] },
  { id: "river-deepseek", provider: "river", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", eligible: false, reasons: ["quota_observation_missing"], warnings: ["river_credit_state_unknown"] }
], reasons: [], warnings: ["shadow_only", "metric_freshness_unconfirmed", "suggested_agent_mismatch"] }));
`, { mode: 0o755 });
  return bin;
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decision-router-test-"));
  const bin = makeProvider(dir);
  const tokenizer = makeTokenizer(dir);
  const shadow = makeShadow(dir);
  const calls = path.join(dir, "calls.log");
  const tokenCalls = path.join(dir, "tokenize-calls.log");
  const shadowCalls = path.join(dir, "shadow-calls.log");
  const env = { ...process.env, DECISION_ROUTER_PROVIDER_BIN: bin,
    DECISION_ROUTER_TOKENIZE_BIN: tokenizer,
    DECISION_ROUTER_CACHE_DIR: path.join(dir, "cache"),
    FAKE_CALLS: calls, FAKE_TOKENIZE_CALLS: tokenCalls, FAKE_SHADOW_CALLS: shadowCalls };
  delete env.NODE_OPTIONS;
  delete env.DECISION_ROUTER_TOKENIZER_URL;
  delete env.DECISION_ROUTER_SHADOW_ALLOCATOR;
  const run = (event, extra = {}, timeout = 3000) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event), encoding: "utf8", timeout, env: { ...env, ...extra }
  });
  const shadowEnv = (extra = {}) => ({ ...env, DECISION_ROUTER_SHADOW_ALLOCATOR: shadow, ...extra });
  const dispose = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, bin, tokenizer, shadow, calls, tokenCalls, shadowCalls, env, shadowEnv, run, dispose };
}

function event(command, session = "s1", cwd = "/tmp") {
  return { session_id: session, cwd, tool_name: "Bash", tool_input: { command } };
}

function callCount(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").length : 0;
}

function cachedFiles(env) {
  const dir = env.DECISION_ROUTER_CACHE_DIR;
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => path.join(dir, name)) : [];
}

function taskArgument(f) {
  const argv = JSON.parse(fs.readFileSync(path.join(f.dir, "argv.json"), "utf8"));
  return argv[argv.indexOf("--task") + 1];
}

function reasonOf(result) {
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
}

function assertFailOpen(result) {
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput, undefined);
  assert.match(output.systemMessage, /fail-open/);
}

const ADVICE = { ok: true, kind: "routine", suggested_agent: "pi", effort: "low", risk: "low" };
const BUDGET = 357;

test("finds a dispatch, ignoring quoted or unrelated mentions", () => {
  assert.equal(parseInvocation("orca-worker-start --name fix-ui --reason 'small UI fix'").name, "fix-ui");
  assert.equal(parseInvocation("cd /repo && /home/me/.local/bin/orca-worker-start --name fix-ui --check-only").name, "fix-ui");
  assert.equal(parseInvocation("echo orca-worker-start --name fix-ui"), null);
  assert.equal(parseInvocation("rg 'orca-worker-start' scripts"), null);
  assert.equal(parseInvocation("orca-worker-start --help"), null);
});

test("keeps shell separators inside quoted arguments and finds piped or background dispatches", () => {
  const quoted = parseInvocation("orca-worker-start --name a --reason 'x; y'");
  assert.equal(quoted.name, "a");
  assert.equal(quoted.reason, "x; y");
  assert.equal(parseInvocation("orca-worker-start --name fix --reason \"split && merge; keep\" --title \"a\nb\"").reason,
    "split && merge; keep");
  assert.equal(parseInvocation("printf 'x' | /usr/bin/orca-worker-start --name piped").name, "piped");
  assert.equal(parseInvocation("sleep 1 & orca-worker-start --name bg").name, "bg");
  assert.equal(parseInvocation("echo 'a | orca-worker-start --name z'"), null);
  assert.equal(parseInvocation("echo 'x; orca-worker-start --name z'"), null);
});

test("treats quoted substitutions as data and never executes them", () => {
  const f = fixture();
  try {
    const marker = path.join(f.dir, "pwned");
    const command = "orca-worker-start --name x --reason '$(touch " + marker + ")' --title \"`touch " + marker + ".2`\"";
    const argvFile = path.join(f.dir, "argv.json");
    const result = f.run(event(command), { FAKE_ARGV: argvFile });
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.some((arg) => arg.includes("$(touch " + marker + ")")));
    assert.ok(argv.some((arg) => arg.includes("`touch " + marker + ".2`")));
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(marker + ".2"), false);
  } finally { f.dispose(); }
});

test("uses spec text without executing shell substitutions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decision-router-spec-"));
  try {
    fs.writeFileSync(path.join(dir, "job.md"), "UI screenshot review\n$(touch pwned)");
    const match = parseInvocation("orca-worker-start --name feat-card --title 'Card' --spec-file job.md");
    const summary = summarizeTask(match, dir);
    assert.match(summary, /UI screenshot review/);
    assert.equal(fs.existsSync(path.join(dir, "pwned")), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("first dispatch is denied once with advice, retry is allowed", () => {
  const f = fixture();
  try {
    const first = f.run(event("orca-worker-start --name fix-ui --reason 'small task' --agent codex --effort high --check-only"));
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /suggested_agent=pi/);
    const retry = f.run(event("orca-worker-start --name fix-ui --reason 'small task' --agent pi --effort low"));
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(retry.stdout.trim(), "");
    assert.equal(callCount(f.calls), 1);
  } finally { f.dispose(); }
});

test("different Dispatch names cause independent classification", () => {
  const f = fixture();
  try {
    for (const name of ["fix-one", "fix-two"]) {
      assert.match(f.run(event("orca-worker-start --name " + name + " --reason 'task'")).stdout, /"deny"/);
    }
    assert.equal(callCount(f.calls), 2);
  } finally { f.dispose(); }
});

test("changed spec content is a different Dispatch and a retry is cached", () => {
  const f = fixture();
  try {
    const cwd = f.dir;
    const command = "orca-worker-start --name same --spec-file job.md";
    fs.writeFileSync(path.join(cwd, "job.md"), "first instruction");
    assert.match(f.run(event(command, "s1", cwd)).stdout, /"deny"/);
    fs.writeFileSync(path.join(cwd, "job.md"), "second instruction");
    assert.match(f.run(event(command, "s1", cwd)).stdout, /"deny"/);
    assert.equal(f.run(event(command, "s1", cwd)).stdout.trim(), "");
    assert.equal(callCount(f.calls), 2);
  } finally { f.dispose(); }
});

test("provider responses outside the known contract fail open with a notice", () => {
  const f = fixture();
  try {
    for (const mode of ["missing-agent", "bad-json", "unknown-kind", "secret-agent", "newline-agent"]) {
      const result = f.run(event("orca-worker-start --name x --reason task"), { FAKE_MODE: mode });
      assertFailOpen(result);
    }
    assert.deepEqual(cachedFiles(f.env), []);
    const valid = f.run(event("orca-worker-start --name codex --reason task"), { FAKE_MODE: "high-risk" });
    assert.match(valid.stdout, /suggested_agent=codex/);
  } finally { f.dispose(); }
});

test("a missing provider stays silent, other failures show a fail-open notice", () => {
  const f = fixture();
  try {
    const missing = f.run(event("orca-worker-start --name fix-a --reason task"),
      { DECISION_ROUTER_PROVIDER_BIN: path.join(f.dir, "no-such-d1") });
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(missing.stdout.trim(), "");
    assertFailOpen(f.run(event("orca-worker-start --name fix-a --reason task"), { FAKE_FAIL: "1" }));
  } finally { f.dispose(); }
});

test("provider timeout, unrelated tools and malformed input fail open", () => {
  const f = fixture();
  try {
    const started = Date.now();
    const timeout = f.run(event("orca-worker-start --name slow --reason task"), { FAKE_SLEEP: "7000" }, 9000);
    assertFailOpen(timeout);
    assert.ok(Date.now() - started < 8000);
    assert.equal(f.run(event("echo hi")).stdout.trim(), "");
    for (const tool of ["Edit", "Write"]) {
      const other = event("orca-worker-start --name fix-b --reason task");
      other.tool_name = tool;
      assert.equal(f.run(other).stdout.trim(), "");
    }
    assert.equal(f.run({ session_id: "s", cwd: "/tmp", tool_name: "Bash" }).stdout.trim(), "");
    const bad = spawnSync(process.execPath, [HOOK], { input: "{", encoding: "utf8", timeout: 3000, env: f.env });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout.trim(), "");
  } finally { f.dispose(); }
});

test("short input within the byte bound skips the tokenizer", () => {
  const f = fixture();
  try {
    const result = f.run(event("orca-worker-start --name tiny --reason 'fix typo'"));
    assert.match(result.stdout, /"deny"/);
    assert.equal(callCount(f.tokenCalls), 0);
    assert.equal(callCount(f.calls), 1);
  } finally { f.dispose(); }
});

test("a whitespace-only instruction is not sent to the provider", () => {
  const f = fixture();
  try {
    const result = f.run(event("orca-worker-start --name ws --reason '   '"));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "");
    assert.equal(callCount(f.calls), 0);
  } finally { f.dispose(); }
});

test("a long instruction is trimmed to the measured token budget, keeping both ends", () => {
  const f = fixture();
  try {
    const long = "HEAD\n" + "あ".repeat(20_000) + "\nTAIL";
    const command = "orca-worker-start --name long --reason '" + long + "'";
    const result = f.run(event(command), { FAKE_ARGV: path.join(f.dir, "argv.json"), FAKE_MAX_TASK_CHARS: "700" });
    assert.equal(result.status, 0, result.stderr);
    const reason = reasonOf(result);
    assert.match(reason, /input_truncated=true/);
    assert.match(reason, /risk=medium/);
    assert.doesNotMatch(reason, /risk=low/);
    assert.match(reason, /トークン上限/);
    assert.match(reason, /途中の条件/);
    const task = taskArgument(f);
    assert.ok(task.startsWith("HEAD"), task.slice(0, 40));
    assert.ok(task.endsWith("TAIL"), task.slice(-40));
    assert.ok(task.includes(TRIM_MARKER));
    assert.ok(Math.ceil(Array.from(task).length * 0.55) <= BUDGET);
    assert.equal(callCount(f.tokenCalls) >= 1, true);
    assert.equal(f.run(event(command)).stdout.trim(), "");
    const high = f.run(event("orca-worker-start --name long-high --reason '" + long + "'"), { FAKE_MODE: "high-risk" });
    assert.match(reasonOf(high), /risk=high/);
  } finally { f.dispose(); }
});

test("wide characters are trimmed by tokens, not by a fixed character count", () => {
  const f = fixture();
  try {
    const command = "orca-worker-start --name wide --reason '" + "𠮟".repeat(600) + "'";
    const result = f.run(event(command), { FAKE_ARGV: path.join(f.dir, "argv.json"),
      FAKE_TOKENIZE_RATIO: "4", FAKE_MAX_TASK_CHARS: "90" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(reasonOf(result), /input_truncated=true/);
    const task = taskArgument(f);
    assert.ok(Array.from(task).length <= 90, String(Array.from(task).length));
    assert.ok(Math.ceil(Array.from(task).length * 4) <= BUDGET);
  } finally { f.dispose(); }
});

test("input that fits the token budget is not marked truncated", () => {
  const f = fixture();
  try {
    const body = "word ".repeat(200);
    const result = f.run(event("orca-worker-start --name fits --reason '" + body + "'"),
      { FAKE_ARGV: path.join(f.dir, "argv.json"), FAKE_TOKENIZE_RATIO: "0.25" });
    assert.equal(result.status, 0, result.stderr);
    const reason = reasonOf(result);
    assert.doesNotMatch(reason, /input_truncated=true/);
    assert.match(reason, /risk=low/);
    assert.equal(taskArgument(f), body);
  } finally { f.dispose(); }
});

test("an unreachable tokenizer falls back to a guaranteed byte budget", () => {
  const f = fixture();
  try {
    const long = "あ".repeat(3_000);
    const result = f.run(event("orca-worker-start --name bytes --reason '" + long + "'"),
      { FAKE_ARGV: path.join(f.dir, "argv.json"), FAKE_TOKENIZE_FAIL: "1", FAKE_MAX_TASK_CHARS: "121" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(reasonOf(result), /input_truncated=true/);
    const task = taskArgument(f);
    assert.ok(Buffer.byteLength(task, "utf8") <= BUDGET);
    assert.ok(task.includes(TRIM_MARKER));
  } finally { f.dispose(); }
});

test("high-risk terms in a dropped middle still raise risk and effort", () => {
  const f = fixture();
  try {
    const long = "HEAD\n" + "本番にデプロイして課金を止める\n" + "あ".repeat(3_000) + "\nTAIL";
    const result = f.run(event("orca-worker-start --name danger --reason '" + long + "'"),
      { FAKE_MAX_TASK_CHARS: "700" });
    assert.equal(result.status, 0, result.stderr);
    const reason = reasonOf(result);
    assert.match(reason, /risk=high/);
    assert.match(reason, /effort=high/);
    assert.match(reason, /high_risk_input=true/);
    assert.match(reason, /input_truncated=true/);
    assert.doesNotMatch(reason, /risk=low/);
  } finally { f.dispose(); }
});

test("unreadable or oversized spec input is incomplete and never low risk", () => {
  const f = fixture();
  try {
    const cwd = f.dir;
    const missing = "orca-worker-start --name spec-missing --reason 'simple task' --spec-file missing.md";
    const missingReason = reasonOf(f.run(event(missing, "s1", cwd)));
    assert.match(missingReason, /input_incomplete=true/);
    assert.match(missingReason, /risk=medium/);
    assert.doesNotMatch(missingReason, /risk=low/);
    assert.match(missingReason, /読み取れない/);
    assert.equal(f.run(event(missing, "s1", cwd)).stdout.trim(), "");

    fs.writeFileSync(path.join(cwd, "big.md"), "x".repeat(70_000));
    const big = f.run(event("orca-worker-start --name spec-big --reason task --spec-file big.md", "s1", cwd));
    assert.match(reasonOf(big), /input_incomplete=true/);

    fs.mkdirSync(path.join(cwd, "adir"));
    const directory = f.run(event("orca-worker-start --name spec-dir --reason task --spec-file adir", "s1", cwd));
    assert.match(reasonOf(directory), /input_incomplete=true/);
  } finally { f.dispose(); }
});

test("cache keeps only validated advice and no task text or secrets", () => {
  const f = fixture();
  try {
    const secret = "SECRET_MARKER_123";
    const result = f.run(event("orca-worker-start --name secret --reason '" + secret + "'"), { FAKE_MODE: "echo-extra" });
    assert.match(result.stdout, /"deny"/);
    const files = cachedFiles(f.env);
    assert.equal(files.length, 1);
    const raw = fs.readFileSync(files[0], "utf8");
    assert.equal(raw.includes(secret), false);
    const record = JSON.parse(raw);
    assert.deepEqual(Object.keys(record).sort(), ["advice", "when"]);
    assert.deepEqual(Object.keys(record.advice).sort(), ["effort", "kind", "risk", "suggested_agent"]);
    assert.equal(fs.statSync(files[0]).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.env.DECISION_ROUTER_CACHE_DIR).mode & 0o777, 0o700);
  } finally { f.dispose(); }
});

test("cache expires after thirty minutes and ignores malformed records", () => {
  const f = fixture();
  try {
    const invocation = parseInvocation("orca-worker-start --name ttl --reason task");
    const ev = event("orca-worker-start --name ttl --reason task");
    const key = dispatchKey(ev, invocation);
    writeCache(key, { when: Date.now() - 29 * 60_000, advice: ADVICE }, f.env);
    assert.ok(readCache(key, f.env));
    writeCache(key, { when: Date.now() - 30 * 60_000 - 1, advice: ADVICE }, f.env);
    assert.equal(readCache(key, f.env), null);
    writeCache(key, { when: Date.now() + 120_000, advice: ADVICE }, f.env);
    assert.equal(readCache(key, f.env), null);
    writeCache(key, { when: Date.now(), advice: { ok: true } }, f.env);
    assert.equal(readCache(key, f.env), null);

    writeCache(key, { when: Date.now() - 30 * 60_000 - 1, advice: ADVICE }, f.env);
    assert.match(f.run(ev).stdout, /"deny"/);
    writeCache(key, { when: Date.now() - 29 * 60_000, advice: ADVICE }, f.env);
    assert.equal(f.run(ev).stdout.trim(), "");
  } finally { f.dispose(); }
});

test("status reports ready only for a valid advice contract", () => {
  const f = fixture();
  try {
    assert.equal(status(f.env).ready, true);
    assert.equal(status({ ...f.env, DECISION_ROUTER_PROVIDER_BIN: path.join(f.dir, "missing") }).ready, false);
    assert.equal(status({ ...f.env, FAKE_MODE: "missing-agent" }).ready, false);
  } finally { f.dispose(); }
});

test("concurrent dispatches leave one parseable cache record", async () => {
  const f = fixture();
  const runAsync = (name) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env: f.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(event("orca-worker-start --name " + name + " --reason task")));
  });
  try {
    const [one, two] = await Promise.all([runAsync("same"), runAsync("same")]);
    let denied = 0;
    for (const result of [one, two]) {
      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.stdout === "" || /"deny"/.test(result.stdout), result.stdout);
      if (/"deny"/.test(result.stdout)) denied += 1;
    }
    assert.ok(denied >= 1);
    const files = cachedFiles(f.env);
    assert.equal(files.length, 1);
    const record = JSON.parse(fs.readFileSync(files[0], "utf8"));
    assert.equal(record.advice.kind, "routine");
    assert.equal(f.run(event("orca-worker-start --name same --reason task")).stdout.trim(), "");
  } finally { f.dispose(); }
});

test("dispatch key ignores model and effort and includes instruction content", () => {
  const invocation = { name: "fix-x", task: null, followup: null, specFiles: [] };
  assert.equal(dispatchKey(event("abc"), invocation), dispatchKey(event("different text"), invocation));
  const withText = { ...invocation, title: "T", reason: "R" };
  assert.notEqual(dispatchKey(event("same"), invocation), dispatchKey(event("same"), withText));
});

// Requires the real local d1 service; run with DECISION_ROUTER_TEST_LOCAL=1.
test("real local d1 accepts the measured token budget", {
  skip: process.env.DECISION_ROUTER_TEST_LOCAL !== "1"
}, () => {
  const text = "READMEの誤字を修正する。".repeat(200).slice(0, 3000);
  const fitted = fitToTokenBudget(text, process.env);
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.text.length < text.length);
  const advice = routeTask(fitted.text, process.env);
  assert.ok(advice, "expected advice from the real d1 service");
  assert.ok(["routine", "implementation", "investigation", "visual", "critical"].includes(advice.kind));
});

test("no shadow allocator configured leaves the advice unchanged", () => {
  const f = fixture();
  try {
    const result = f.run(event("orca-worker-start --name plain --reason task"));
    assert.match(reasonOf(result), /suggested_agent=pi/);
    assert.doesNotMatch(reasonOf(result), /候補評価/);
    assert.equal(callCount(f.shadowCalls), 0);
  } finally { f.dispose(); }
});

test("shadow candidates are advisory, never cached, and never see task text", () => {
  const f = fixture();
  try {
    const secret = "TASK_ONLY_MARKER_555";
    const command = "orca-worker-start --name shadow --reason '" + secret + "'";
    const argvFile = path.join(f.dir, "shadow-argv.json");
    const result = f.run(event(command), f.shadowEnv({ FAKE_SHADOW_ARGV: argvFile }));
    assert.equal(result.status, 0, result.stderr);
    const reason = reasonOf(result);
    assert.match(reason, /spark-local\/DeepSeek-V4\.1-Flash-1017/);
    assert.match(reason, /quota_observation_missing/);
    assert.match(reason, /metric_freshness_unconfirmed/);
    assert.match(reason, /提案であり/);
    assert.equal(callCount(f.shadowCalls), 1);

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("--classification"));
    assert.equal(argv.includes("--explicit-model"), false);
    assert.equal(argv.join(" ").includes(secret), false);
    assert.equal(argv.includes("--log"), false);

    const retry = f.run(event(command), f.shadowEnv());
    assert.equal(retry.stdout.trim(), "");
    assert.equal(callCount(f.shadowCalls), 1);
    assert.equal(callCount(f.calls), 1);

    const raw = fs.readFileSync(cachedFiles(f.env)[0], "utf8");
    assert.equal(raw.includes(secret), false);
    assert.equal(raw.includes("DeepSeek"), false);
  } finally { f.dispose(); }
});

test("missing, relative, failing and malformed shadow tools only drop the candidate note", () => {
  const f = fixture();
  try {
    const cases = [
      [path.join(f.dir, "no-such-shadow"), "shadow_allocator_missing"],
      ["scripts/d1-shadow-allocate", "shadow_allocator_invalid"],
      [{ FAKE_SHADOW_MODE: "fail" }, "shadow_unavailable"],
      [{ FAKE_SHADOW_MODE: "bad-json" }, "shadow_invalid_response"],
      [{ FAKE_SHADOW_MODE: "wrong-shape" }, "shadow_invalid_response"]
    ];
    for (const [index, [setting, code]] of cases.entries()) {
      const extra = typeof setting === "string"
        ? { DECISION_ROUTER_SHADOW_ALLOCATOR: setting } : setting;
      const result = f.run(event("orca-worker-start --name case-" + index + " --reason task"), f.shadowEnv(extra));
      assert.equal(result.status, 0, result.stderr);
      const reason = reasonOf(result);
      assert.match(reason, new RegExp(code));
      assert.match(reason, /suggested_agent=pi/);
      assert.doesNotMatch(reason, /SECRET_MARKER_777/);
    }
  } finally { f.dispose(); }
});

test("a slow shadow tool stays inside the hook budget", () => {
  const f = fixture();
  try {
    const started = Date.now();
    const result = f.run(event("orca-worker-start --name slow-shadow --reason task"),
      f.shadowEnv({ FAKE_SHADOW_SLEEP: "5000" }), 9000);
    const elapsed = Date.now() - started;
    assert.equal(result.status, 0, result.stderr);
    assert.match(reasonOf(result), /shadow_timeout/);
    assert.match(reasonOf(result), /suggested_agent=pi/);
    assert.ok(elapsed < 6000, String(elapsed));
  } finally { f.dispose(); }
});

test("unknown capacity is shown as reasons without eligible candidates", () => {
  const f = fixture();
  try {
    const result = f.run(event("orca-worker-start --name capacity --reason task"),
      f.shadowEnv({ FAKE_SHADOW_MODE: "capacity" }));
    const reason = reasonOf(result);
    assert.match(reason, /適格な候補はありません/);
    assert.match(reason, /quota_observation_missing/);
    assert.match(reason, /quota_not_assignable/);
    assert.match(reason, /metric_freshness_unconfirmed/);
    assert.match(reason, /suggested_agent=pi/);
  } finally { f.dispose(); }
});

test("trimmed or incomplete input skips candidate evaluation", () => {
  const f = fixture();
  try {
    const long = "あ".repeat(3_000);
    const trimmed = f.run(event("orca-worker-start --name trim-shadow --reason '" + long + "'"),
      f.shadowEnv({ FAKE_TOKENIZE_FAIL: "1", FAKE_MAX_TASK_CHARS: "121" }));
    const trimmedReason = reasonOf(trimmed);
    assert.match(trimmedReason, /input_truncated=true/);
    assert.match(trimmedReason, /候補評価: 入力がトークン上限/);

    const cwd = f.dir;
    const missing = f.run(event("orca-worker-start --name spec-shadow --reason task --spec-file missing.md", "s1", cwd),
      f.shadowEnv());
    const missingReason = reasonOf(missing);
    assert.match(missingReason, /input_incomplete=true/);
    assert.match(missingReason, /候補評価: 指示書の一部/);

    assert.equal(callCount(f.shadowCalls), 0);
  } finally { f.dispose(); }
});

test("high risk skips candidate evaluation", () => {
  const f = fixture();
  try {
    const result = f.run(event("orca-worker-start --name high-shadow --reason task"),
      f.shadowEnv({ FAKE_MODE: "high-risk" }));
    const reason = reasonOf(result);
    assert.match(reason, /risk=high/);
    assert.doesNotMatch(reason, /候補評価/);
    assert.equal(callCount(f.shadowCalls), 0);
  } finally { f.dispose(); }
});

test("an explicit model is passed to the candidate evaluator", () => {
  const f = fixture();
  try {
    const argvFile = path.join(f.dir, "shadow-argv.json");
    const result = f.run(event("orca-worker-start --name explicit --model spark-local/DeepSeek-V4.1-Flash-1017 --reason task"),
      f.shadowEnv({ FAKE_SHADOW_ARGV: argvFile }));
    assert.equal(result.status, 0, result.stderr);
    assert.match(reasonOf(result), /suggested_agent=pi/);
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const at = argv.indexOf("--explicit-model");
    assert.ok(at >= 0);
    assert.equal(argv[at + 1], "spark-local/DeepSeek-V4.1-Flash-1017");
  } finally { f.dispose(); }
});

test("--model and --model= are parsed; an unsafe value skips candidate advice", () => {
  assert.equal(parseInvocation("orca-worker-start --name a --model river/x").model, "river/x");
  assert.equal(parseInvocation("orca-worker-start --name a --model=spark-local/y").model, "spark-local/y");
  assert.equal(parseInvocation("orca-worker-start --name a --model").model, null);
  const f = fixture();
  try {
    const result = f.run(event("orca-worker-start --name unsafe --model 'x\nUNSAFE_MARKER' --reason task"), f.shadowEnv());
    const reason = reasonOf(result);
    assert.match(reason, /explicit_model_unresolved/);
    assert.equal(reason.includes("UNSAFE_MARKER"), false);
    assert.match(reason, /suggested_agent=pi/);
    assert.equal(callCount(f.shadowCalls), 0);
  } finally { f.dispose(); }
});

test("an explicit model does not change the Dispatch identity for retries", () => {
  const base = event("orca-worker-start --name same-model --reason task");
  const withModel = event("orca-worker-start --name same-model --model pi/one --reason task");
  assert.equal(
    dispatchKey(base, parseInvocation(base.tool_input.command)),
    dispatchKey(withModel, parseInvocation(withModel.tool_input.command)));

  const f = fixture();
  try {
    const command = "orca-worker-start --name retry-model --model spark-local/x --reason task";
    assert.match(f.run(event(command), f.shadowEnv()).stdout, /"deny"/);
    assert.equal(f.run(event("orca-worker-start --name retry-model --reason task"), f.shadowEnv()).stdout.trim(), "");
    assert.equal(callCount(f.calls), 1);
    assert.equal(callCount(f.shadowCalls), 1);
  } finally { f.dispose(); }
});

test("shadow parser accepts only the documented shape", () => {
  const good = parseShadowResult(JSON.stringify({
    mode: "shadow", advisory_only: true, auto_launch: false,
    candidates: [{ id: "spark-local-deepseek", provider: "spark-local",
      model: "DeepSeek-V4.1-Flash-1017", eligible: true, reasons: [], warnings: ["local_cache_unknown"] }],
    reasons: [], warnings: ["shadow_only"]
  }));
  assert.equal(good.candidates.length, 1);
  assert.deepEqual(good.warnings, ["shadow_only"]);

  for (const bad of [
    "not json",
    JSON.stringify({ mode: "shadow", advisory_only: true, auto_launch: true, candidates: [] }),
    JSON.stringify({ mode: "shadow", advisory_only: false, auto_launch: false, candidates: [] }),
    JSON.stringify({ mode: "shadow", advisory_only: true, auto_launch: false,
      candidates: [{ id: "bad\nSECRET", provider: "p", model: "m", eligible: true, reasons: [], warnings: [] }] }),
    JSON.stringify({ mode: "shadow", advisory_only: true, auto_launch: false, candidates: [],
      reasons: ["Quota bad"], warnings: [] })
  ]) assert.equal(parseShadowResult(bad), null);
});
