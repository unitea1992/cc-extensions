---
description: Show the stored final output for a finished DSH job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result text and any error messages
- The DSH session ID and the resume command exactly as reported
- Follow-up commands such as `/dsh:status <id>`
