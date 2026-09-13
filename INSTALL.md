# Install — Keen Mastering (5 minutes)

**Prerequisites:** Node 18+, ngrok, and Claude Code (or another MCP-capable agent). No Go — the binaries are prebuilt.

1. Unpack the package and open a terminal **in this folder**.
2. `claude` — start Claude Code here. Approve the `.mcp.json` prompt (it registers the `keen` MCP server for this folder only).
3. Type `/keen-install` — **once per machine, always first**: copies the prebuilt `keen-validate` + `keen-deploy` for your machine into `~/.local/bin`, installs the runner, checks the prerequisites. (`/keen-start` refuses to run until this has been done.)
4. Type `/keen-start` (or just say hello — the agent runs it on its first reply). You get the **WELCOME TO KEENAGENTS** banner and a choice:
   - **Create new project** — a short wizard (space name, agent name, sandbox URL, MCP account id + secret, the flow project path, the entanglement path; sensible defaults for the rest), then the agent performs the whole 15-step setup end to end — space, agent, API chain, ngrok + webhook, rebuild + wake, an MCP consumer and its token, validate + deploy — and saves everything under `working_dir/<spaceId>/`.
   - **List existing projects** — pick a saved project; the agent reconnects, logs in and continues where you left off.
   - **No copy of the entanglement site yet?** `/keen-entanglement-download` fetches the public reference site into a folder you name (zip → unpacked there → zip deleted); give that folder to the wizard as the entanglement path.
5. From then on: `cd working_dir/<spaceId>` is where `keen-validate`, `keen-deploy` and the runner find their `.env`. Say what you want built or changed.

**Checking a project later:** `/keen-project-validate` — pick it, get a pass/fail table (files, platform, site + tunnel, credentials) and the exact fix for anything wrong.
**Working without a project (just log in as an MCP account):** `/keen-start` → **Just connect**.

**Self-signed local certificate:** the local endpoint is plain HTTP on port 5545, so nothing to trust. To use `https://localhost/mcp` instead, start Claude Code with `NODE_EXTRA_CA_CERTS=<path to the sandbox's server.crt>`.
**Where secrets live:** never in this folder's committed files — `agent-runner/.env` and the entanglement `.env.local` are yours to keep private.
