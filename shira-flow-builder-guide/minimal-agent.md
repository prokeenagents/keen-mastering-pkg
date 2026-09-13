# Recipe — a minimal agent that just answers

The smallest useful flow: a user says something, an LLM answers. This is the exact `.flow` an assistant
should produce when asked *"build me an initial agent that just answers."* Nothing more is needed.

---

## What "just answers" needs

Three nodes, wired in a line:

```
Start ─▶ LLM ─▶ End
```

- **Start** — the entry door.
- **LLM (Agent)** — configured with a **model** and (optionally) a **System** prompt. It automatically
  reads the user's message as its prompt and produces the answer. **No Script is required** to answer.
- **End** — the terminator.

That's everything: the user's message arrives in the conversation, the LLM reads it, answers, and the
answer streams back to the user.

## The complete `.flow`

Save this as **`Assistant.flow`** in the project's `src/flows/` folder:

```json
{
  "nodes": [
    {
      "id": "startNode_A1b2C3d4E5f6",
      "type": "startNode",
      "position": { "x": 320, "y": 80 },
      "data": {
        "label": "Start", "description": "Entry point",
        "labelNode": "Start Flow", "descriptionNode": "Flow entry point",
        "open": false, "settings": { "value": "Start", "label": "Start" }
      },
      "dragHandle": ".drag-handle__custom"
    },
    {
      "id": "agentNode_G7h8I9j0K1l2",
      "type": "agentNode",
      "position": { "x": 320, "y": 280 },
      "data": {
        "label": "", "description": "Answers the user",
        "labelNode": "LLM", "descriptionNode": "Use LLM processor",
        "open": false, "openLLM": false, "openPrompt": false,
        "settings": {
          "sessionId": "", "requestId": "",
          "agentId": "assistant", "agentName": "Assistant",
          "llm": {
            "company": "anthropic", "model": "claude-opus-4-5", "modelId": 4927,
            "parameters": { "temperature": 1, "maxTokens": 8192, "effort": 1 }
          },
          "specialRules": [],
          "prompts": [
            { "role": "system", "content": "You are a helpful assistant. Answer the user's question clearly and concisely." }
          ]
        }
      },
      "dragHandle": ".drag-handle__custom"
    },
    {
      "id": "endNode_M3n4O5p6Q7r8",
      "type": "endNode",
      "position": { "x": 320, "y": 480 },
      "data": {
        "label": "End", "description": "",
        "labelNode": "End Flow", "descriptionNode": "Flow terminal",
        "open": false, "settings": { "value": "End", "label": "End", "terminateDictionary": false }
      },
      "dragHandle": ".drag-handle__custom"
    }
  ],
  "edges": [
    {
      "type": "step",
      "source": "startNode_A1b2C3d4E5f6", "sourceHandle": "next",
      "target": "agentNode_G7h8I9j0K1l2", "targetHandle": "in",
      "id": "xy-edge__startNode_A1b2C3d4E5f6next-agentNode_G7h8I9j0K1l2in"
    },
    {
      "type": "step",
      "source": "agentNode_G7h8I9j0K1l2", "sourceHandle": "next_1",
      "target": "endNode_M3n4O5p6Q7r8", "targetHandle": "in",
      "id": "xy-edge__agentNode_G7h8I9j0K1l2next_1-endNode_M3n4O5p6Q7r8in"
    }
  ]
}
```

## The rules an assistant must follow when generating this

- **Node ids:** `<type>_` + 12 random `A–Za–z0–9` (the `<type>_` prefix is mandatory — the engine reads
  the kind from it). Don't reuse ids.
- **Fixed fields per node:** `labelNode` / `descriptionNode` are the fixed titles (Start Flow / Flow entry
  point · LLM / Use LLM processor · End Flow / Flow terminal); `dragHandle` is always
  `".drag-handle__custom"`.
- **Handles:** Start out = **`next`**; Agent in = `in`, out = **`next_1`**; End in = `in`. Edges carry
  `"type": "step"` and the id `xy-edge__<source><sourceHandle>-<target><targetHandle>`.
- **Start label** = one capitalized word, letters only (`Start`). The **file** is `Assistant.flow`, so the
  entry is **`Assistant-Start`**.
- **Agent** must have `agentId` (slug) + `agentName` + an `llm` block; a **System** prompt is optional but
  recommended. Leave `sessionId` / `requestId` **empty**.
- Top level is exactly `{ "nodes": [...], "edges": [...] }`.

## Making the agent run it

In the admin console, create an agent whose:

- **Start Flow** = `Assistant` (the file name),
- **Start Node** = `Start` (the Start node's label),
- **Agent ID (slug)** = `assistant` (matches `settings.agentId`),
- and it's **Active**.

Then **deploy** the project into the agent's space and connect a client. The user types a question → the
LLM answers. (See `keen-admin-guide/03-spaces-and-agents.md` and `keen-admin-guide/04-deploy-a-project.md`.)

> Want the agent to *do* things (look data up, call an API) before answering? Add a **Script** or give it
> **tools** — see `nodes/script-node.md` and `tool-calling.md`. But to *just answer*, the three nodes
> above are all you need.

---

*A slightly bigger worked example (with a Script and a second entry point) is in `example-basic-flow.md`.*
