# librechat-router

JEV-9B-driven model router in front of [LibreChat](https://www.librechat.ai/).

It lets one conversation **swap models message-by-message**: image requests go
to the image-generation agent, everything else stays on the standard Spark
model. The decision is made by a small [JEV-9B](https://github.com/j-ev) model
on every message, so "draw a blue fox" routes to the image model and the next
message "tell me a fun fact" routes straight back to Spark — no manual agent
switching.

```
what is 2 plus 2?          -> Spark (Receptionist)
draw a blue fox            -> Image Creator   (image generated)
tell me a fun fact         -> Spark (Receptionist)   <- swapped back
```

## How it works

The router is a reverse proxy. It passes every request through to LibreChat
unchanged, **except** `POST /api/agents/chat/*` requests on the two managed
agents. For those it asks JEV-9B whether the message wants an image and rewrites
the request's `agent_id` to the matching agent:

- image  -> Image Creator
- other  -> Receptionist (answers on the standard Spark model)

Because it manages both agents, the swap works in both directions regardless of
which agent the client currently thinks it is talking to. It **fails open**: if
JEV-9B is slow or down, the request is forwarded unchanged so chat never breaks.

Full details, the JEV-9B protocol, and the swap mechanics are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

Requires Node.js >= 20.

```sh
# syntax check + test suite
make lint
make test

# run locally (needs LibreChat API + JEV-9B reachable)
make hooks          # optional: install the git hooks
node server.js
```

The router listens on `:3081` by default. Point your reverse proxy at it instead
of the LibreChat API directly.

### Docker

```sh
make docker        # build the image
docker run --env-file .env -p 3081:3081 librechat-router
```

Or use the provided [docker-compose.yml](docker-compose.yml).

## Configuration

All settings are environment variables with sensible defaults. Copy
[.env.example](.env.example) to `.env` and adjust.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3081` | Port the router listens on. |
| `UPSTREAM_HOST` | `librechat-api` | LibreChat API host (container name on the shared network). |
| `UPSTREAM_PORT` | `3080` | LibreChat API port. |
| `JEV_BASE` | `http://192.168.50.106:8081` | JEV-9B gateway host:port. |
| `JEV_PATH` | `/upstream/jev-9b/v1/decide` | JEV-9B `/v1/decide` route. |
| `RECEPTIONIST_ID` | `agent_3fs4vNxAoN9duaGKlwObE` | Public id of the default agent (answers non-image on Spark). |
| `ROUTER_AGENT_ID` | `agent_hgrCkcWQEk8znW4L5zoMe` | Public id of the image-generation agent. |
| `ROUTER_AGENT_MODEL` | `qwen38-27b-nvfp4-single-node` | Image agent model (informational). |
| `ROUTER_THRESHOLD` | `0.5` | Route to the image agent when `pImage` exceeds this. |
| `JEV_TIMEOUT_MS` | `10000` | JEV-9B decision timeout before failing open. |

> The agent ids are the **public** ids (the `id` field), not the Mongo `_id`.
> Find yours via `GET /api/agents` or in the LibreChat UI.

## Deployment

1. Build the image: `docker build -t librechat-router .`
2. Run it on the same docker network as the LibreChat API so it can reach
   `UPSTREAM_HOST`:
   ```sh
   docker run -d --name librechat-router \
     --net <librechat-network> \
     -e UPSTREAM_HOST=librechat-api \
     -e RECEPTIONIST_ID=<your-receptionist-id> \
     -e ROUTER_AGENT_ID=<your-image-creator-id> \
     -p 3081:3081 librechat-router
   ```
3. Point your reverse proxy (nginx/traefik) at `:3081` instead of the LibreChat
   API port.

Verify with the router log — each managed message should log a routing decision:

```
route msg conv=new from=Receptionist "draw a blue fox"
route -> Image Creator (rewriting from Receptionist; choice=image, pImage=0.992, thr=0.5)
```

## Testing

The test suite ([test/router.test.js](test/router.test.js)) has no external
dependencies. Unit tests cover the pure routing decision; integration tests
spin up a mock JEV-9B and a mock upstream and drive the real HTTP handler to
prove the `agent_id` rewrite end-to-end (both directions, plus pass-through for
non-managed agents).

```sh
make test        # node --test
```

## Git hooks

The repo ships a [pre-commit](.githooks/pre-commit) hook (lint + test) and a
[commit-msg](.githooks/commit-msg) hook (enforces Conventional Commits). Install
them once:

```sh
make hooks       # sets core.hooksPath=.githooks
```

## Project layout

```
server.js            the router (HTTP proxy + JEV-9B routing)
Dockerfile           node:22-alpine image
Makefile             test / lint / docker / hooks targets
test/router.test.js  unit + integration tests (node:test, no deps)
docs/ARCHITECTURE.md deep-dive on the routing + swap mechanics
.env.example         all configuration variables, documented
docker-compose.yml   example deployment
.github/workflows/ci.yml  CI: lint+test, then docker build+push to GHCR
```

## License

[MIT](LICENSE).
