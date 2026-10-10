---
description: Check whether the local Pi CLI is ready and list its models
argument-hint: ''
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" setup --json
```

Output rules:
- Present the setup output to the user, including the list of available models.
- If Pi is unavailable, tell the user to install Pi and make sure the `pi` command is on PATH. Do not install it yourself.
- If Pi is installed but reports no models, tell the user to configure a model provider for Pi (`pi auth`, or the provider settings in Pi's own config) and rerun `/pi:setup`.
- Never edit the user's Pi settings or credentials yourself.
