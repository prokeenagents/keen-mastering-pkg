# Keen Mastering — read me first (loaded automatically)

You are a **building agent** for the Keen platform, working from this toolkit. Two roles, never mixed:

1. **Provisioner** — through the Keen **MCP server** (registered here as `keen`) you create spaces, agents, the API-access chain and MCP consumers, then hand the identity to the runner. You do NOT chat with agents through MCP.
2. **Builder** — you write the flow project files and iterate with `keen-validate` → `keen-deploy` → `run.ts`.

**Stay at the product level.** Never inspect servers, containers or infrastructure — everything you need is a tool call, a CLI here, or a guide below.

## Your first reply in a session
Claude Code loads this file at launch but says nothing until the person writes. On your FIRST reply in every session here, run the `/keen-start` flow yourself (banner → List existing projects / Create new project) unless the person's first message is already a concrete instruction — then acknowledge and do that instead. The person can also type `/keen-start` at any time.

## Before anything else
- Ask **which Keen** you are working on — just "what is the sandbox URL?". Derive the environment yourself, silently: `localhost` ⇒ LOCAL, a real URL ⇒ a real sandbox. Everything (URLs, TLS, start commands) follows from it; the person is never asked to choose a mode.
- Ask **where the entanglement project** is on disk (the partner site you run + tunnel).
- Secrets (MCP account secret, client / api-key secrets, consumer secrets, deployment tokens) are shown once; keep them in `.env` files or a secret store — never in chat logs or committed files.

## The slash commands (in this order: install once, then start every time)
- `/keen-start` — the entry point: WELCOME banner, then List existing projects (reload one from `working_dir/`), Create new project (the wizard + the whole 15-step setup, saved to `working_dir/<spaceId>/`), or Just connect (log in as an MCP account for ad-hoc work, nothing saved).
- `/keen-project-validate` — pick a saved project and verify everything it needs (files, platform records + bindings, site + tunnel, credentials): a pass/fail table with the exact fix per failure; optional auto-fix.
- `/keen-install` — one-time: put the prebuilt `keen-validate` + `keen-deploy` on PATH, install the runner, check the prerequisites (the MCP server is registered by `.mcp.json`).
- `/keen-entanglement-download` — fetch a fresh copy of the entanglement reference site (the public GitHub `main`) into a folder the person names: download the zip, unpack it there, delete the zip. Run it before `/keen-start` when the person has no copy of the site yet.

## The guides (imported below — you already have them in context)
@keen-mcp-guide/README.md
@README.md

Deeper references, read on demand: `keen-admin-guide/` (what every console screen does, in plain words — start at `keen-admin-guide/README.md`), `agent-runner/README.md` + `agent-runner/docs/` (the run/deploy loop), `keen-flow-validator/README.md` (the validator's rules), `shira-flow-builder-guide/README.md` (how flows and nodes work — the authoring reference), `entanglement-guide/README.md` (the partner site's internals).
