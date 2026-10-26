# Example — a basic flow (and multiple entry points)

A first, elementary flow, and the idea it demonstrates: **one flow file can have several Start nodes**, so
you can enter the same flow at different points.

---

## The flow, in words

```
Start ─▶ Script (init.js) ─▶ LLM (AgentOne) ─▶ End
                               ▲
Entry ─────────────────────────┘
```

- **`Start`** is the top entry: it runs the **full** pipeline — a **Script** (`init.js`) to prepare data,
  then the **LLM** agent (`AgentOne`) to respond, then **End**.
- **`Entry`** is a **second Start node** in the *same file* that wires **straight into the LLM** — it
  **skips** the Script and enters the flow "in the middle".

Both are real, addressable entry points of this one flow. `Start` and `Entry` each have their own
**`File-Label`** address (here `Project-Start` and `Project-Entry`).

## Why multiple Start nodes

A Start node is a **named door** into the graph. Putting more than one in a file lets a caller (an agent,
or a Run/Jump/Parallel from another flow) pick **where to enter**:

- Run the whole thing → enter at **`Project-Start`**.
- Jump in past the setup, straight to the agent → enter at **`Project-Entry`**.

Same file, same nodes, different starting doors. (See `nodes/start-flow-node.md` → *You can have many Start
nodes*.)

## The `.flow` file

```json
{
  "nodes": [
    {
      "id": "startNode_a1b2c3d4e5f6",
      "type": "startNode",
      "position": { "x": 480, "y": 48 },
      "data": {
        "label": "Start", "description": "Some interesting description",
        "labelNode": "Start Flow", "descriptionNode": "Flow entry point",
        "open": false, "settings": { "value": "Start", "label": "Start" }
      },
      "dragHandle": ".drag-handle__custom"
    },
    {
      "id": "startNode_g7h8i9j0k1l2",
      "type": "startNode",
      "position": { "x": 48, "y": 480 },
      "data": {
        "label": "Entry", "description": "",
        "labelNode": "Start Flow", "descriptionNode": "Flow entry point",
        "open": false, "settings": { "value": "Entry", "label": "Entry" }
      },
      "dragHandle": ".drag-handle__custom"
    },
    {
      "id": "scriptNode_m3n4o5p6q7r8",
      "type": "scriptNode",
      "position": { "x": 480, "y": 480 },
      "data": {
        "label": "", "description": "",
        "labelNode": "Script", "descriptionNode": "Execute custom JS script",
        "open": false, "settings": { "value": "init.js", "label": "My Script", "keyValuePairs": [] }
      },
      "dragHandle": ".drag-handle__custom"
    },
    {
      "id": "agentNode_s9t0u1v2w3x4",
      "type": "agentNode",
      "position": { "x": 480, "y": 912 },
      "data": {
        "label": "", "description": "This is the initial agent",
        "labelNode": "LLM", "descriptionNode": "Use LLM processor",
        "open": false,
        "settings": {
          "sessionId": "", "requestId": "",
          "agentId": "agent-one", "agentName": "AgentOne",
          "llm": {
            "company": "anthropic", "model": "claude-opus-4-5", "modelId": 4927,
            "parameters": { "temperature": 1, "maxTokens": 8192, "effort": 1 }
          },
          "specialRules": []
        }
      },
      "dragHandle": ".drag-handle__custom"
    },
    {
      "id": "endNode_y5z6a7b8c9d0",
      "type": "endNode",
      "position": { "x": 480, "y": 1344 },
      "data": {
        "label": "Terminal", "description": "",
        "labelNode": "End Flow", "descriptionNode": "Flow terminal",
        "open": false, "settings": { "value": "Terminal", "label": "Terminal", "terminateDictionary": false }
      },
      "dragHandle": ".drag-handle__custom"
    }
  ],
  "edges": [
    {
      "type": "step",
      "source": "startNode_a1b2c3d4e5f6", "sourceHandle": "next",
      "target": "scriptNode_m3n4o5p6q7r8", "targetHandle": "in",
      "id": "xy-edge__startNode_a1b2c3d4e5f6next-scriptNode_m3n4o5p6q7r8in"
    },
    {
      "type": "step",
      "source": "scriptNode_m3n4o5p6q7r8", "sourceHandle": "next_1",
      "target": "agentNode_s9t0u1v2w3x4", "targetHandle": "in",
      "id": "xy-edge__scriptNode_m3n4o5p6q7r8next_1-agentNode_s9t0u1v2w3x4in"
    },
    {
      "type": "step",
      "source": "startNode_g7h8i9j0k1l2", "sourceHandle": "next",
      "target": "agentNode_s9t0u1v2w3x4", "targetHandle": "in",
      "id": "xy-edge__startNode_g7h8i9j0k1l2next-agentNode_s9t0u1v2w3x4in"
    },
    {
      "type": "step",
      "source": "agentNode_s9t0u1v2w3x4", "sourceHandle": "next_1",
      "target": "endNode_y5z6a7b8c9d0", "targetHandle": "in",
      "id": "xy-edge__agentNode_s9t0u1v2w3x4next_1-endNode_y5z6a7b8c9d0in"
    }
  ]
}
```

### What to notice (each references a node page)

- **Two `startNode`s** — `Start` (`next` → Script) and `Entry` (`next` → straight to the LLM). A Start
  node's out handle id is `next`. → `nodes/start-flow-node.md`
- **Script** `init.js` — `in` from Start, **`next_1`** (Out) → LLM, **`error`** (Error) left unwired here.
  → `nodes/script-node.md`
- **LLM** `AgentOne` (`agentId: "agent-one"`) — receives from **both** the Script and `Entry` on its `in`
  (`agentNode.in` is **multi-in** — see `field-rules.md` — and only one entry runs per chat turn anyway);
  **`next_1`** → End,
  **`error`** (Fallback) unwired. → `nodes/agent-node.md`
- **End** — `in` only. → `nodes/end-flow-node.md`
- Every edge carries **`"type": "step"`** and the five identity fields.
- Positions are on the 16px grid, **432px** apart along the chain and across the two columns
  (`best-practices.md` → *Canvas layout*).

## Running it — matching the agent

To have a Keen **agent** run this, set the agent's **Start Flow** = the file name (`Project`) and its
**Start Node** = the entry you want:

- **Start Node `Start`** → runs `Start → Script → LLM → End` (the full pipeline).
- **Start Node `Entry`** → runs `Entry → LLM → End` (skips the script).

Both must be **PascalCase** and match the Start node labels **exactly** (see `nodes/start-flow-node.md` →
*The link to the agent*, and `keen-admin-guide/03-spaces-and-agents.md`).

> The node ids above are illustrative (`startNode_` + 12 chars). On the canvas they're generated for you;
> when you write the file by hand, generate 12 random `A–Za–z0–9` characters per node (unique in the file)
> and build each edge `id` from them.

---

*See `business-objects.md` for how data moves between these nodes, and each `nodes/*.md` for the node.*
