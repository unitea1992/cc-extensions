import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  applyRunEvent,
  buildGitHardeningEnv,
  buildModelArgument,
  buildReadOnlyAgentConfig,
  buildRunArgs,
  buildRunConfigContent,
  createRunState,
  finalMessageFromState,
  parseStructuredOutput,
  READ_ONLY_AGENT,
  readOutputSchema,
  validateAgainstSchema
} from "../plugins/opencode/scripts/lib/opencode.mjs";
import { renderReviewResult } from "../plugins/opencode/scripts/lib/render.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_SCHEMA = readOutputSchema(path.join(ROOT, "plugins", "opencode", "schemas", "review-output.schema.json"));

// Same matcher as OpenCode v2 (packages/core/src/util/wildcard.ts) with last-match-wins evaluation.
function wildcardMatch(input, pattern) {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) {
    escaped = `${escaped.slice(0, -3)}( .*)?`;
  }
  return new RegExp(`^${escaped}$`, "s").test(input);
}

function evaluate(action, resource) {
  const rules = buildReadOnlyAgentConfig().permissions;
  const match = [...rules].reverse().find((rule) => wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource));
  return match?.effect ?? "ask";
}

test("read-only agent allows reading and read-only git, and denies every write path", () => {
  assert.equal(evaluate("read", "/repo/src/app.js"), "allow");
  assert.equal(evaluate("glob", "/repo"), "allow");
  assert.equal(evaluate("grep", "/repo"), "allow");
  for (const command of ["git status", "git status --short", "git diff", "git diff --stat main...HEAD", "git log -5 --oneline", "git show HEAD:src/app.js"]) {
    assert.equal(evaluate("shell", command), "allow", command);
  }
  for (const [action, resource] of [
    ["edit", "/repo/src/app.js"],
    ["write", "/repo/new.txt"],
    ["shell", "touch made.txt"],
    ["shell", "rm -rf src"],
    ["shell", "git diff > out.patch"],
    ["shell", "git status >> log.txt"],
    ["shell", "git diff --output=out.patch"],
    ["shell", "git log --output out.txt"],
    ["shell", "git diff --ext-diff"],
    ["shell", "git log $(touch x)"],
    ["shell", "git log `touch x`"],
    ["shell", "git difftool"],
    ["shell", "git commit -m x"],
    ["shell", "git checkout -- ."],
    ["shell", "npm install"],
    ["read", "/repo/.env"],
    ["read", "/repo/.env.local"],
    ["external_directory", "/etc"],
    ["webfetch", "https://example.com"],
    ["subagent", "general"],
    ["mcp_xserver_deploy", "*"]
  ]) {
    assert.equal(evaluate(action, resource), "deny", `${action} ${resource}`);
  }
  assert.equal(evaluate("read", "/repo/.env.example"), "allow");
});

test("run config injects the read-only agent and keeps the caller's own config content", () => {
  const merged = JSON.parse(
    buildRunConfigContent(JSON.stringify({ model: "local/qwen", agents: { mine: { description: "keep me" } } }))
  );
  assert.equal(merged.model, "local/qwen");
  assert.equal(merged.agents.mine.description, "keep me");
  assert.deepEqual(merged.agents[READ_ONLY_AGENT], buildReadOnlyAgentConfig());

  const fromInvalid = JSON.parse(buildRunConfigContent("{not json"));
  assert.deepEqual(Object.keys(fromInvalid.agents), [READ_ONLY_AGENT]);
});

test("run args use a private server, JSON events, and the right agent", () => {
  assert.deepEqual(buildRunArgs({ readOnly: true, title: "OpenCode Companion Task: x" }), [
    "run",
    "--standalone",
    "--format",
    "json",
    "--thinking",
    "--agent",
    READ_ONLY_AGENT,
    "--title",
    "OpenCode Companion Task: x"
  ]);
  const writeArgs = buildRunArgs({ readOnly: false, model: "fake/alpha", effort: "high", resumeSessionId: "ses_1", title: "ignored" });
  assert.deepEqual(writeArgs.slice(5), ["--agent", "build", "--model", "fake/alpha#high", "--session", "ses_1"]);
  assert.ok(!writeArgs.includes("--auto"));
});

test("model argument maps effort to an OpenCode variant and rejects ambiguous input", () => {
  assert.equal(buildModelArgument(null, null), null);
  assert.equal(buildModelArgument("fake/alpha", null), "fake/alpha");
  assert.equal(buildModelArgument("fake/alpha", "low"), "fake/alpha#low");
  assert.equal(buildModelArgument("fake/alpha#max", null), "fake/alpha#max");
  assert.throws(() => buildModelArgument(null, "high"), /needs `--model provider\/model`/);
  assert.throws(() => buildModelArgument("alpha", null), /provider\/model/);
  assert.throws(() => buildModelArgument("fake/alpha#max", "high"), /already selects a variant/);
});

test("run events produce the final message, session id, reasoning, touched files, and errors", () => {
  const progress = [];
  const state = createRunState({ onProgress: (event) => progress.push(event) });
  const events = [
    { type: "step_start", sessionID: "ses_1", part: { messageID: "m1" } },
    { type: "reasoning", sessionID: "ses_1", part: { messageID: "m1", text: "Look at the diff first." } },
    { type: "text", sessionID: "ses_1", part: { messageID: "m1", text: "Let me check." } },
    { type: "tool_use", sessionID: "ses_1", part: { tool: "edit", state: { status: "completed", input: { filePath: "/repo/a.js" } } } },
    { type: "tool_use", sessionID: "ses_1", part: { tool: "write", state: { status: "error", input: { filePath: "/repo/b.js" }, error: "denied" } } },
    { type: "tool_use", sessionID: "ses_1", part: { tool: "shell", state: { status: "completed", input: { command: "npm test" } } } },
    { type: "text", sessionID: "ses_1", part: { messageID: "m2", text: "Fixed " } },
    { type: "text", sessionID: "ses_1", part: { messageID: "m2", text: "the bug." } },
    { type: "step_finish", sessionID: "ses_1", part: { reason: "stop" } }
  ];
  for (const event of events) {
    applyRunEvent(state, event);
  }
  assert.equal(state.sessionId, "ses_1");
  assert.equal(finalMessageFromState(state), "Fixed the bug.");
  assert.deepEqual(state.reasoningSummary, ["Look at the diff first."]);
  assert.deepEqual([...state.touchedFiles], ["/repo/a.js"]);
  assert.ok(progress.some((event) => event.threadId === "ses_1"));
  assert.ok(progress.some((event) => event.phase === "verifying" && /npm test/.test(event.message)));
  assert.ok(progress.some((event) => event.phase === "editing"));

  applyRunEvent(state, { type: "error", sessionID: "ses_1", error: { name: "APIError", data: { message: "rate limited" } } });
  assert.equal(state.error.message, "rate limited");
});

test("structured output parsing accepts bare, fenced, and prose-wrapped JSON", () => {
  const payload = { verdict: "approve", summary: "ok", findings: [], next_steps: [] };
  const json = JSON.stringify(payload);
  assert.deepEqual(parseStructuredOutput(json).parsed, payload);
  assert.deepEqual(parseStructuredOutput(`Here you go:\n\n\`\`\`json\n${json}\n\`\`\`\n`).parsed, payload);
  assert.deepEqual(parseStructuredOutput(`Result: ${json} (end)`).parsed, payload);

  const broken = parseStructuredOutput("no json here");
  assert.equal(broken.parsed, null);
  assert.ok(broken.parseError);
  assert.match(parseStructuredOutput("", { failureMessage: "provider down" }).parseError, /provider down/);
});

test("schema validation reports review-output.schema.json violations", () => {
  const valid = {
    verdict: "needs-attention",
    summary: "One issue.",
    findings: [
      {
        severity: "high",
        title: "Bug",
        body: "Details.",
        file: "a.js",
        line_start: 1,
        line_end: 2,
        confidence: 0.9,
        recommendation: "Fix it."
      }
    ],
    next_steps: ["Fix it."]
  };
  assert.deepEqual(validateAgainstSchema(valid, REVIEW_SCHEMA), []);

  const errors = validateAgainstSchema(
    {
      verdict: "maybe",
      summary: "",
      findings: [{ severity: "urgent", title: "x", body: "y", file: "a.js", line_start: 0, confidence: 2, recommendation: "" }],
      next_steps: [],
      extra: 1
    },
    REVIEW_SCHEMA
  );
  for (const expected of [
    /\$\.verdict must be one of/,
    /\$\.summary must not be empty/,
    /\$\.findings\[0\]\.severity must be one of/,
    /\$\.findings\[0\]\.line_start must be >= 1/,
    /\$\.findings\[0\]\.line_end is required/,
    /\$\.findings\[0\]\.confidence must be <= 1/,
    /\$\.extra is not allowed/
  ]) {
    assert.ok(errors.some((error) => expected.test(error)), `missing ${expected}: ${errors.join("; ")}`);
  }
});

test("review rendering lists schema warnings without hiding the findings", () => {
  const output = renderReviewResult(
    {
      parsed: { verdict: "approve", summary: "Looks fine.", findings: [], next_steps: [], extra: true },
      schemaErrors: ["$.extra is not allowed"],
      rawOutput: "{}"
    },
    { reviewLabel: "Review", targetLabel: "working tree diff" }
  );
  assert.match(output, /^# OpenCode Review/);
  assert.match(output, /Verdict: approve/);
  assert.match(output, /Schema warnings/);
  assert.match(output, /\$\.extra is not allowed/);
});

test("structured output prefers a schema-valid block over an earlier example block", () => {
  const example = JSON.stringify({ verdict: "approve", summary: "example" });
  const real = JSON.stringify({ verdict: "needs-attention", summary: "Real review.", findings: [], next_steps: [] });
  const output = `Format example:\n\n\`\`\`json\n${example}\n\`\`\`\n\nFinal:\n\n\`\`\`json\n${real}\n\`\`\`\n`;
  const result = parseStructuredOutput(output, { schema: REVIEW_SCHEMA });
  assert.equal(result.parsed.summary, "Real review.");
  assert.deepEqual(result.schemaErrors, []);

  const onlyInvalid = parseStructuredOutput(example, { schema: REVIEW_SCHEMA });
  assert.equal(onlyInvalid.parsed.summary, "example");
  assert.ok(onlyInvalid.schemaErrors.length > 0);
});

test("a failed run never renders a partial approval as a finished review", () => {
  const output = renderReviewResult(
    {
      parsed: { verdict: "approve", summary: "Looks fine.", findings: [], next_steps: [] },
      schemaErrors: [],
      rawOutput: "{\"verdict\":\"approve\"}"
    },
    { reviewLabel: "Review", targetLabel: "working tree diff", runFailure: "Provider rejected the request." }
  );
  assert.match(output, /failed before the review finished/);
  assert.match(output, /Provider rejected the request\./);
  assert.doesNotMatch(output, /Verdict: approve/);
  assert.doesNotMatch(output, /No material findings/);
});

test("git hardening stops repository-configured programs from running during read-only git", { skip: process.platform === "win32" }, () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, ".gitattributes"), "*.txt diff=evil filter=evil\n");
  fs.writeFileSync(path.join(repo, "f.txt"), "a\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  run("git", ["config", "diff.evil.textconv", "sh -c 'touch PWNED_textconv; cat \"$0\"'"], { cwd: repo });
  run("git", ["config", "diff.evil.command", "sh -c 'touch PWNED_command'"], { cwd: repo });
  run("git", ["config", "filter.evil.clean", "sh -c 'touch PWNED_clean; cat'"], { cwd: repo });
  run("git", ["config", "filter.evil.process", "sh -c 'touch PWNED_process; exit 1'"], { cwd: repo });
  run("git", ["config", "diff.external", "sh -c 'touch PWNED_external'"], { cwd: repo });
  run("git", ["config", "core.fsmonitor", "sh -c 'touch PWNED_fsmonitor'"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "f.txt"), "a\nb\n");

  const env = { ...process.env, ...buildGitHardeningEnv(repo, process.env) };
  delete env.GIT_EXTERNAL_DIFF;
  const diff = run("git", ["diff"], { cwd: repo, env });
  assert.equal(diff.status, 0, diff.stderr);
  assert.match(diff.stdout, /\+b/);
  for (const args of [["diff", "--cached"], ["status"], ["log", "-p", "-1"], ["show", "HEAD"]]) {
    const result = run("git", args, { cwd: repo, env });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  }
  assert.deepEqual(fs.readdirSync(repo).filter((name) => name.startsWith("PWNED")), []);

  // Without hardening the same commands do run the configured programs.
  run("git", ["diff"], { cwd: repo });
  assert.ok(fs.readdirSync(repo).some((name) => name.startsWith("PWNED")));
});

test("git hardening appends to an existing GIT_CONFIG_COUNT instead of replacing it", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const hardening = buildGitHardeningEnv(repo, { ...process.env, GIT_CONFIG_COUNT: "2" });
  assert.equal(hardening.GIT_CONFIG_KEY_2, "core.fsmonitor");
  assert.equal(hardening.GIT_CONFIG_KEY_0, undefined);
  assert.equal(Number(hardening.GIT_CONFIG_COUNT), 2 + Object.keys(hardening).filter((key) => key.startsWith("GIT_CONFIG_KEY_")).length);
});
