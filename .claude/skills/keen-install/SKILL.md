---
name: keen-install
description: One-time setup of the Keen Mastering toolkit — put the prebuilt keen-validate + keen-deploy binaries for this machine on PATH, install the agent-runner, check the prerequisites. Run once after unpacking the package; then run /keen-start.
disable-model-invocation: true
allowed-tools: Bash Read AskUserQuestion
---

Set up this toolkit on this machine. Work from the package root (the folder that holds this `.claude/`). Nothing is compiled — the tools ship prebuilt in `bin/`. Do every step, report what you did, and stop at the first hard failure with the exact error and what the person must install.

## 1. Prerequisites — check, don't assume
Run and report versions: `node --version` (18+), `npm --version`, `ngrok version`, `claude --version`. Go is NOT required. A missing one is a stop: tell the person exactly what to install (Node from nodejs.org, ngrok from ngrok.com/download) and end.

## 2. Pick the prebuilt binaries for THIS machine
Detect the platform: `uname -s` (Linux / Darwin; on Windows use `$env:OS` / `systeminfo`) and `uname -m` (`x86_64` ⇒ `amd64`, `aarch64`/`arm64` ⇒ `arm64`). The matching files are:
- `bin/keen-validate-<os>-<arch>` and `bin/keen-deploy-<os>-<arch>` (`<os>` = `linux` | `darwin` | `windows`, Windows files end in `.exe`).
Install them under the plain names:
```bash
mkdir -p ~/.local/bin
cp bin/keen-validate-<os>-<arch> ~/.local/bin/keen-validate && chmod +x ~/.local/bin/keen-validate
cp bin/keen-deploy-<os>-<arch>   ~/.local/bin/keen-deploy   && chmod +x ~/.local/bin/keen-deploy
```
(Windows: copy the two `.exe` files to a folder on `PATH`, e.g. `%USERPROFILE%\bin`, as `keen-validate.exe` / `keen-deploy.exe`.) On macOS, if Gatekeeper blocks them: `xattr -d com.apple.quarantine ~/.local/bin/keen-*`.
Verify `keen-validate --help` and `keen-deploy --help` print usage. If `~/.local/bin` is not on `PATH` (`command -v keen-validate` fails), show the person the exact line to add to their shell profile and keep using the absolute paths meanwhile.

## 3. Install the runner
```bash
(cd agent-runner && npm install)
```
Confirm `npx --prefix agent-runner tsx agent-runner/run.ts --help` prints usage. Do NOT create or edit `agent-runner/.env` here — `/keen-start` fills it per project (working_dir/<spaceId>/.env).

## 4. The Keen MCP server
`.mcp.json` in the package root already declares the server named `keen` (project scope — it travels with the folder and loads automatically when Claude Code starts here, after a one-time approval prompt). Run `/keen-start` next — it points the server at the right sandbox and logs in.

## 5. Report
One short table: prerequisite versions, platform detected, the two binary paths, runner installed yes/no, and the sentence "Next: run /keen-start".
