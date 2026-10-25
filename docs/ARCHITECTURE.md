# Architecture

`librechat-router` is a thin reverse proxy that sits between the public chat
port and the LibreChat API. Its only job is to decide, **per message**, whether
the user wants an image, and to route the request to the right agent.

## Request flow

```
Browser ──> reverse proxy (nginx/traefik) ──> librechat-router:3081 ──> librechat-api:3080
                                                      │
                                                      │ (managed-agent chat POSTs only)
                                                      ▼
                                                   JEV-9B /v1/decide
```

- **Everything** is passed through to LibreChat unchanged, except `POST
  /api/agents/chat/*` requests whose `agent_id` is one of the two managed agents.
- For those requests the router buffers the body, asks JEV-9B to classify the
  message, and rewrites `agent_id` to the chosen target before forwarding.

## The two managed agents

| Agent | Public id | Model | Role |
|-------|-----------|-------|------|
| Receptionist | `agent_3fs4vNxAoN9duaGKlwObE` | `qwen38-27b-nvfp4` (Spark) | Default front-door; answers everything non-image. |
| Image Creator | `agent_hgrCkcWQEk8znW4L5zoMe` | `qwen38-27b-nvfp4-single-node` | Generates/edits images. |

> The ids above are the **public** agent ids (the `id` field), not the Mongo
> `_id`. They are what the LibreChat UI and `/api/agents` use. Set
> `RECEPTIONIST_ID` / `ROUTER_AGENT_ID` to your own.

## The routing decision

For each eligible message the router POSTs to JEV-9B:

```json
{ "kind": "choice", "state": "<message text>", "question": "<instructions>",
  "options": ["image", "other"], "thinking": "off" }
```

and reads back `{ "choice": "image"|"other", "probabilities": [pImage, ...] }`.

The target is:

- **Image Creator** when `choice === "image"` **or** `pImage > ROUTER_THRESHOLD`
- **Receptionist/Spark** otherwise

`choice === "image"` is treated as authoritative even at a low `pImage`; the
`pImage` check is a safety net for when JEV returns a low-confidence `other`
that is still above the threshold.

## Per-message model swap

A single conversation can move between the two models message-by-message, in
both directions:

1. The user's first message arrives on the Receptionist (the default agent).
2. If it is an image request the router rewrites it to Image Creator; the
   client then re-binds the conversation to Image Creator (it follows whichever
   agent answered).
3. The next message arrives with `agent_id = Image Creator`. If it is
   **not** an image request the router rewrites it back to Receptionist/Spark,
   and the client re-binds back.

Because the router manages **both** agents, the swap works regardless of which
agent the client currently thinks it is talking to. Any other agent (a
user-selected specialist, etc.) is never touched.

## Fail-open

If JEV-9B times out (`JEV_TIMEOUT_MS`), errors, or returns unparseable JSON,
the router logs it and forwards the request **unchanged**. Chat never breaks
because of the router. The default target on failure is Receptionist/Spark.

## Known model blind spot

JEV-9B misclassifies the exact phrase "what is the date" as an image request
(`pImage ≈ 0.64`, above the default 0.5 threshold). Other date phrasings route
correctly. Raise `ROUTER_THRESHOLD` above ~0.65 to suppress this if desired;
that also starts missing genuine borderline image requests, so it is a trade-off.
