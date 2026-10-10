---
name: pi-cli-runtime
description: Internal helper contract for calling the pi-companion runtime from Claude Code
user-invocable: false
---

# Pi Runtime

Use this skill only inside the `pi:pi-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Pi CLI strings, or any other Bash activity.
- Do not call `setup`, `status`, `result`, or `cancel` from `pi:pi-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- Do not inspect the repo, solve the task yourself, or add independent analysis. Forward the request text.
- Leave `--effort` unset unless the user explicitly requests a specific thinking level.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Models use the Pi `provider/model` form. `/pi:setup` lists the available ones.
- Default to a write-capable Pi run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass it through to `task` unchanged.
- If the forwarded request includes `--effort`, pass it through to `task`. Valid values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- If the forwarded request includes `--idle-timeout <seconds>`, pass it through to `task` unchanged.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable Pi work in `pi:pi-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Pi cannot be invoked, return nothing.
