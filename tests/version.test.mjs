import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  bumpVersion,
  changelogHasVersion,
  checkAgainstBase,
  compareVersions,
  currentVersion
} from "../tools/version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every version field agrees and the changelog covers the current version", () => {
  const version = currentVersion(ROOT);
  assert.ok(changelogHasVersion(ROOT, version), `CHANGELOG.md needs a "## ${version}" section`);
});

test("bump levels follow semantic versioning", () => {
  assert.equal(bumpVersion("0.2.3", "patch"), "0.2.4");
  assert.equal(bumpVersion("0.2.3", "minor"), "0.3.0");
  assert.equal(bumpVersion("0.2.3", "major"), "1.0.0");
  assert.throws(() => bumpVersion("0.2.3", "huge"), /Unknown bump level/);
  assert.throws(() => bumpVersion("0.2", "patch"), /MAJOR.MINOR.PATCH/);
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
});

const PLUGIN_NAMES = ["opencode", "typescript7-lsp"];

function writeVersions(repo, version) {
  fs.mkdirSync(path.join(repo, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ version }));
  for (const name of PLUGIN_NAMES) {
    fs.mkdirSync(path.join(repo, "plugins", name, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(repo, "plugins", name, ".claude-plugin", "plugin.json"), JSON.stringify({ version }));
  }
  fs.writeFileSync(
    path.join(repo, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ metadata: { version }, plugins: PLUGIN_NAMES.map((name) => ({ name, version })) })
  );
}

function commitAll(repo, message) {
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["commit", "-q", "-m", message], { cwd: repo });
}

test("a plugin change without a version bump fails the base check", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  writeVersions(repo, "0.2.0");
  fs.writeFileSync(path.join(repo, "plugins", "opencode", "runtime.mjs"), "export const a = 1;\n");
  commitAll(repo, "base");
  run("git", ["branch", "base"], { cwd: repo });

  fs.mkdirSync(path.join(repo, "tests"));
  fs.writeFileSync(path.join(repo, "tests", "a.test.mjs"), "// test only\n");
  commitAll(repo, "tests only");
  assert.deepEqual(checkAgainstBase(repo, "base").errors, []);

  fs.writeFileSync(path.join(repo, "plugins", "opencode", "runtime.mjs"), "export const a = 2;\n");
  commitAll(repo, "plugin change");
  assert.match(checkAgainstBase(repo, "base").errors.join("\n"), /plugins\/opencode changed .* still 0\.2\.0/);

  writeVersions(repo, "0.2.1");
  commitAll(repo, "bump");
  assert.deepEqual(checkAgainstBase(repo, "base").errors, []);
});

test("a change to any plugin without a version bump fails the base check", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  writeVersions(repo, "0.2.0");
  fs.writeFileSync(path.join(repo, "plugins", "typescript7-lsp", "wrapper.mjs"), "export const a = 1;\n");
  commitAll(repo, "base");
  run("git", ["branch", "base"], { cwd: repo });

  fs.writeFileSync(path.join(repo, "plugins", "typescript7-lsp", "wrapper.mjs"), "export const a = 2;\n");
  commitAll(repo, "plugin change");
  assert.match(checkAgainstBase(repo, "base").errors.join("\n"), /plugins\/typescript7-lsp changed .* still 0\.2\.0/);

  writeVersions(repo, "0.3.0");
  commitAll(repo, "bump");
  assert.deepEqual(checkAgainstBase(repo, "base").errors, []);
});

test("mismatched version fields are reported", () => {
  const repo = makeTempDir();
  writeVersions(repo, "0.2.0");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ version: "0.1.0" }));
  assert.throws(() => currentVersion(repo), /Version fields disagree[\s\S]*package.json: 0\.1\.0/);
});
