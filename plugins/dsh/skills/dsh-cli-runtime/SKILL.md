---
name: dsh-cli-runtime
description: Internal helper contract for calling the dsh-companion runtime from Claude Code
user-invocable: false
---

# DSH Runtime

Use this skill only inside the `dsh:dsh-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct `dst` CLI strings, or any other Bash activity.
- Do not call `setup`, `status`, `result`, or `cancel` from `dsh:dsh-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- Do not inspect the repo, solve the task yourself, or add independent analysis. Forward the request text.
- Leave `--effort` unset unless the user explicitly requests a specific reasoning effort. Valid values are model-specific (for example `low`, `high`, `max`); DSH stops the run with UNSUPPORTED_REASONING_EFFORT when a model does not support the requested level.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Models use the DSH `provider/model` form (only the first slash separates provider from model). `/dsh:setup` lists the available ones.
- Default to a write-capable DSH run by adding `--write` unless the user explicitly asks for read-only behavior or only wants a review without edits. A read-only run uses DSH's `read-only` permission mode, so it cannot change files or run state-changing commands.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass it through to `task` unchanged.
- If the forwarded request includes `--effort`, pass it through to `task` unchanged.
- If the forwarded request includes `--write` or `--read-only`, pass it through to `task` unchanged.
- If the forwarded request includes `--timeout <seconds>`, pass it through to `task` unchanged.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run. It resumes the previous DSH session by its id.

Safety rules:
- Default to write-capable DSH work in `dsh:dsh-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or DSH cannot be invoked, return nothing.
