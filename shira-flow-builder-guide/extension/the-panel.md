# The Shira Flow Builder panel (create · connect · deploy)

The extension adds a **Shira Flow Builder** view to the VS Code activity bar. This is where a person using
the canvas scaffolds a project, connects it to a Space, and deploys it. There's also a **Breakpoints** view
next to it. (A building agent works without VS Code: it writes the files by hand and deploys with
`keen-validate` → `keen-deploy` — see the end of this page.)

---

## Settings (read-only chips)

- **Theme** — `dark` / `light`. Flip it with the **Toggle Theme** button in the view's title bar (it sets
  the extension's global theme, which the canvas follows).
- **Models** — shows `"<N> model(s)"`. **N is the number of models you pasted** into the `flowBuilder.aiModels`
  setting — a JSON array of `{ id, model_name, params, company }` entries (this is your `models.json`
  contents). The "**22 models**" you may see is just a 22-entry list pasted there. It **drives the model
  selector** in the LLM node's *LLM Settings*. Empty → `"none"`; bad JSON → `"invalid JSON"`.

## The three buttons — and the lifecycle

The buttons light up in order; this is the whole path from nothing to a running project:

```
empty folder ──▶ Create Project ──▶ fill .vscode/keen.json ──▶ Connect ──▶ Upload Project
```

### 1. Create Project
- **Enabled only when the open folder is empty.**
- Scaffolds the skeleton (see `project-and-files.md`). The panel then flips to **"— detected"**.

### 2. Connect
- **Enabled once a valid project is detected** with no structure errors (a project with errors shows
  "— invalid" and keeps Connect / Upload disabled). `.vscode/keen.json` is checked when you **click**: a
  `[REPLACE…]` placeholder left in it fails the connect with an error toast (`Set "server" in
  .vscode/keen.json first.`).
- Connects to the deploy target in `keen.json`: it sends your **deployment token** + **Space id** and gets
  back a **short-lived session** (held **in memory** — a window reload drops it, so you reconnect). The
  button then reads **Disconnect**. A status-bar item shows **Connected / Not connected**.

### 3. Upload Project
- **Enabled once connected.**
- **Deploys the entire `src/` tree** (zipped) to the connected target; the server **scans** it and, if
  clean, promotes it live. Your agents now run the new code.
- The **first** upload is explicit ("deployed ✓"); after that, **auto-sync re-uploads on every save**
  (debounced ~0.8 s), so your changes keep flowing to the sandbox as you edit.
- If the scan **rejects** the project, the reason appears in **Output ▸ Flow Builder** (fix and re-upload).

> The deploy target is a **space in a KeenAgents instance**. For real behaviour end-to-end you also need
> the agent (in the admin) pointed at a flow + start node that your uploaded project actually contains —
> see `keen-admin-guide/03-spaces-and-agents.md` and `keen-admin-guide/04-deploy-a-project.md`.

## The Breakpoints view

A tree, **one group per `.flow` file**, listing the node breakpoints you've set (each leaf = the node's
name + a short id, e.g. `LLM gc7SBi`). Clicking a leaf **reveals and centres that node** on the canvas.
Title-bar / inline actions let you **remove all**, **remove a file's**, or **remove one** breakpoint.
Breakpoints are stored by the extension (not written into the `.flow` file). Setting them is **F9 on a
selected node** — see `debugging.md`.

---

## What deploy actually does (for the curious)

Connect/Upload talk HTTP to the Keen deploy endpoint: `POST {server}/ms/deploy/v1/project/connect`
(headers `X-AI-Space-Id` = the Space id + `X-Deployment-Token` = the deployment token → a short-lived
session token), then `POST {server}/ms/deploy/v1/project/upload` (multipart field `bundle`, a `bundle.zip`
of your `src/`, with the **session** token in `X-Deployment-Token`); Disconnect is
`POST {server}/ms/deploy/v1/project/disconnect`. Self-signed TLS is tolerated only for `localhost` /
`127.0.0.1`. Inside the extension you never run a CLI or `npm` deploy — it's all the panel. Outside it, the
`keen-deploy` binary speaks the same connect → upload → disconnect protocol (config from `.env`, not
`keen.json`; see `agent-runner/docs/DEPLOY.md`), and `keen-validate` checks the project first.

*Next: `debugging.md` (flow & script debuggers). Project files: `project-and-files.md`.*
