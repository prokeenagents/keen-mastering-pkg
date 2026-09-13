---
name: keen-entanglement-download
description: Fetch a fresh copy of the entanglement reference partner site (the public GitHub repo prokeenagents/entanglement-project, main branch) into a folder the person names — download the zip, unpack it there, delete the zip. Run it when the person has no copy of the site yet; then give that folder to /keen-start as the entanglement path.
disable-model-invocation: true
allowed-tools: Bash Read AskUserQuestion
---

Download the entanglement site into a folder of the person's choosing. Do exactly this — ask for the path, download, unpack, delete the zip, report. Nothing is installed or started here; that is `/keen-start`'s job.

## 1. Ask for the destination
Ask ONE question with AskUserQuestion — "Where should the entanglement site be unpacked? (an absolute path; the folder may not exist yet)" — with the single option **"Type my own"**, and WAIT for the answer. Never propose a path, never pre-fill one from disk. Expand a leading `~`; resolve a relative path against the current folder and show the person the absolute path you will use.

## 2. Check the destination
- Missing → create it: `mkdir -p "<destination>"`.
- Exists and is empty → fine.
- Exists and is NOT empty → stop and ask (AskUserQuestion, two options): **"Unpack into it anyway — files with the same names are overwritten"** / **"Cancel — I'll give another path"**. Never delete anything that is already there; on Cancel go back to step 1.

## 3. Download the archive
The source is fixed — the public `main` branch of the reference site:
```
https://github.com/prokeenagents/entanglement-project/archive/refs/heads/main.zip
```
```bash
TMP="$(mktemp -d)"
curl -fsSL -o "$TMP/entanglement.zip" "https://github.com/prokeenagents/entanglement-project/archive/refs/heads/main.zip"
```
No `curl`? `wget -qO "$TMP/entanglement.zip" <url>`. Windows PowerShell: `Invoke-WebRequest -Uri <url> -OutFile "$env:TEMP\entanglement.zip"`. A download failure (offline, 404, proxy) is a stop: show the exact error and end — do not retry blindly.

## 4. Unpack, strip the wrapper folder, delete the zip
GitHub wraps the archive in one top-level folder (`entanglement-project-main/`). The site's files must land DIRECTLY in the destination, not inside that sub-folder — dotfiles (`.env.example`, `.gitignore`) included:
```bash
unzip -q "$TMP/entanglement.zip" -d "$TMP/unpacked"
TOP="$(find "$TMP/unpacked" -mindepth 1 -maxdepth 1 -type d | head -1)"
cp -a "$TOP"/. "<destination>/"
rm -rf "$TMP"
```
The zip and the temp folder are gone after the last line — nothing is left outside the destination. No `unzip`? `tar -xf "$TMP/entanglement.zip" -C "$TMP/unpacked"` (bsdtar reads zip) or `python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$TMP/entanglement.zip" "$TMP/unpacked"`. Windows: `Expand-Archive` to a temp folder, `Move-Item` the inner folder's contents into the destination, `Remove-Item` the zip and the temp folder.

## 5. Verify and report
`ls -A "<destination>"` must show `package.json`, `src/` and `.env.example`; confirm no `*.zip` remains in the destination or the temp folder. Report in three lines: the destination path, the number of files unpacked, "zip deleted". The copy carries no git history — intended: it is a starting point the person owns.

Then say what comes next, without doing it: **`/keen-start` → Create new project** asks for the entanglement path (question 11) — give it this folder; the wizard writes the site's `.env.local`, installs its dependencies and starts it. To run it by hand instead: `cd <destination> && npm install`, copy `.env.example` to `.env.local` and fill it in (never commit `.env.local`).
