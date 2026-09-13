# working_dir — one folder per project (= one Keen space)

`/keen-start` creates and reads these. `<spaceId>/project.json` holds the ids and settings (no secrets); `<spaceId>/.env` holds the secrets (chmod 600) and is what the agent-runner consumes; `<spaceId>/entanglement.env` is the block to paste into the site's `.env.local`. Never commit or ship this folder.
