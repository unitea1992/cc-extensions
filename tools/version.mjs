#!/usr/bin/env node
// Keeps the plugin version in one place of truth across the files that carry it, and checks that a
// change to the shipped plugin comes with a version bump. `claude plugin update` only refreshes an
// installed plugin when its version changes, so an unbumped change never reaches users.
//
//   node tools/version.mjs bump <patch|minor|major>
//   node tools/version.mjs check [--base <git-ref>]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_NAME = "opencode";
const PLUGIN_DIR = "plugins/opencode";
const CHANGELOG = "CHANGELOG.md";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

// Each entry reads and writes one place where the version is recorded.
const VERSION_FIELDS = [
  {
    file: "package.json",
    get: (json) => json.version,
    set: (json, version) => {
      json.version = version;
    }
  },
  {
    file: `${PLUGIN_DIR}/.claude-plugin/plugin.json`,
    get: (json) => json.version,
    set: (json, version) => {
      json.version = version;
    }
  },
  {
    file: ".claude-plugin/marketplace.json",
    label: "metadata.version",
    get: (json) => json.metadata?.version,
    set: (json, version) => {
      json.metadata.version = version;
    }
  },
  {
    file: ".claude-plugin/marketplace.json",
    label: `plugins[${PLUGIN_NAME}].version`,
    get: (json) => json.plugins?.find((plugin) => plugin.name === PLUGIN_NAME)?.version,
    set: (json, version) => {
      json.plugins.find((plugin) => plugin.name === PLUGIN_NAME).version = version;
    }
  }
];

export function parseVersion(version) {
  const match = SEMVER.exec(String(version ?? ""));
  if (!match) {
    throw new Error(`"${version}" is not a MAJOR.MINOR.PATCH version.`);
  }
  return match.slice(1).map(Number);
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return 0;
}

export function bumpVersion(version, level) {
  const [major, minor, patch] = parseVersion(version);
  switch (level) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Unknown bump level "${level}". Use patch, minor, or major.`);
  }
}

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

export function readVersions(root = ROOT) {
  return VERSION_FIELDS.map((field) => ({
    where: field.label ? `${field.file} ${field.label}` : field.file,
    version: field.get(readJson(root, field.file)) ?? null
  }));
}

// Returns the single version all fields agree on, or throws listing the disagreement.
export function currentVersion(root = ROOT) {
  const versions = readVersions(root);
  const distinct = [...new Set(versions.map((entry) => entry.version))];
  if (distinct.length !== 1) {
    throw new Error(
      `Version fields disagree:\n${versions.map((entry) => `  ${entry.where}: ${entry.version}`).join("\n")}`
    );
  }
  parseVersion(distinct[0]);
  return distinct[0];
}

export function changelogHasVersion(root, version) {
  const file = path.join(root, CHANGELOG);
  if (!fs.existsSync(file)) {
    return false;
  }
  const heading = new RegExp(`^## ${version.replace(/\./g, "\\.")}(\\s|$)`, "m");
  return heading.test(fs.readFileSync(file, "utf8"));
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// A change under the plugin directory is what users receive, so it needs a higher version than the
// base. Changes elsewhere (tests, CI, the repository README) do not reach installed plugins.
export function checkAgainstBase(root, base) {
  const changed = git(root, ["diff", "--name-only", `${base}...HEAD`, "--", PLUGIN_DIR])
    .split("\n")
    .filter(Boolean);
  const current = currentVersion(root);
  const baseVersion = JSON.parse(git(root, ["show", `${base}:${PLUGIN_DIR}/.claude-plugin/plugin.json`])).version;
  const errors = [];
  if (changed.length > 0 && compareVersions(current, baseVersion) <= 0) {
    errors.push(
      `${PLUGIN_DIR} changed (${changed.length} file${changed.length === 1 ? "" : "s"}) but the version is still ${current}. ` +
        "Run `npm run version:bump -- <patch|minor|major>` and add a CHANGELOG entry."
    );
  }
  if (compareVersions(current, baseVersion) < 0) {
    errors.push(`The version ${current} is lower than ${baseVersion} on ${base}.`);
  }
  return { changed, current, baseVersion, errors };
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "bump") {
    const previous = currentVersion();
    const next = bumpVersion(previous, rest[0]);
    const byFile = new Map();
    for (const field of VERSION_FIELDS) {
      const json = byFile.get(field.file) ?? readJson(ROOT, field.file);
      field.set(json, next);
      byFile.set(field.file, json);
    }
    for (const [file, json] of byFile) {
      fs.writeFileSync(path.join(ROOT, file), `${JSON.stringify(json, null, 2)}\n`);
    }
    console.log(`${previous} -> ${next}`);
    if (!changelogHasVersion(ROOT, next)) {
      console.log(`Add a "## ${next}" section to ${CHANGELOG}.`);
    }
    return 0;
  }
  if (command === "check") {
    const baseIndex = rest.indexOf("--base");
    const base = baseIndex === -1 ? null : rest[baseIndex + 1];
    const current = currentVersion();
    const errors = [];
    if (!changelogHasVersion(ROOT, current)) {
      errors.push(`${CHANGELOG} has no "## ${current}" section.`);
    }
    if (base) {
      errors.push(...checkAgainstBase(ROOT, base).errors);
    }
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      return 1;
    }
    console.log(`Version ${current} is consistent${base ? ` and bumped as needed against ${base}` : ""}.`);
    return 0;
  }
  console.error("Usage: node tools/version.mjs bump <patch|minor|major> | check [--base <git-ref>]");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
