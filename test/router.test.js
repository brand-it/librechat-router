'use strict';
// Tests for librechat-router. Unit tests cover the pure routing decision; the
// integration tests spin up a mock JEV + mock upstream and drive the real HTTP
// handler to prove the agent_id rewrite end-to-end. No external network is used.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');

const RECEPTIONIST = 'agent_3fs4vNxAoN9duaGKlwObE';
const IMAGE_CREATOR = 'agent_hgrCkcWQEk8znW4L5zoMe';

// server.js reads its config from env at load time, so each test that needs a
// different upstream/JEV endpoint must clear the require cache and re-require
// after setting the env vars it wants.
function loadServer(env) {
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../server.js')];
  return require('../server.js');
}

// ---- unit: pure routing decision (no network) ----
{
  const { isManagedAgent, resolveTarget } = loadServer({
    RECEPTIONIST_ID: RECEPTIONIST,
    ROUTER_AGENT_ID: IMAGE_CREATOR,
    ROUTER_THRESHOLD: '0.5',
  });

  test('isManagedAgent recognizes both managed agents', () => {
    assert.strictEqual(isManagedAgent(RECEPTIONIST), true);
    assert.strictEqual(isManagedAgent(IMAGE_CREATOR), true);
  });

  test('isManagedAgent rejects unknown agents', () => {
    assert.strictEqual(isManagedAgent('agent_something_else'), false);
    assert.strictEqual(isManagedAgent(undefined), false);
    assert.strictEqual(isManagedAgent(null), false);
  });

  test('resolveTarget routes image decisions to Image Creator', () => {
    assert.strictEqual(resolveTarget(RECEPTIONIST, { choice: 'image', pImage: 0.99 }), IMAGE_CREATOR);
    assert.strictEqual(resolveTarget(RECEPTIONIST, { choice: 'other', pImage: 0.99 }), IMAGE_CREATOR); // pImage above threshold wins
    assert.strictEqual(resolveTarget(RECEPTIONIST, { choice: 'image', pImage: 0.2 }), IMAGE_CREATOR); // choice=image is authoritative
  });

  test('resolveTarget routes non-image decisions to Receptionist/Spark', () => {
    assert.strictEqual(resolveTarget(IMAGE_CREATOR, { choice: 'other', pImage: 0.01 }), RECEPTIONIST);
    assert.strictEqual(resolveTarget(RECEPTIONIST, { choice: 'other', pImage: 0.2 }), RECEPTIONIST); // below threshold
  });

  test('resolveTarget fails open to Receptionist/Spark when JEV returns nothing', () => {
    // JEV error/timeout -> null -> not an image -> Receptionist/Spark (the safe default).
    assert.strictEqual(resolveTarget(RECEPTIONIST, null), RECEPTIONIST);
    assert.strictEqual(resolveTarget(IMAGE_CREATOR, null), RECEPTIONIST);
  });
}

// ---- integration: drive the real HTTP handler with mock JEV + mock upstream ----
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function startRouter(handler, port) {
  const router = http.createServer(handler);
  await new Promise((r) => router.listen(port, '127.0.0.1', r));
  return router;
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, path: '/api/agents/chat/agents', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

test('handler rewrites agent_id based on JEV decision (integration)', async (t) => {
  const jevPort = await freePort();
  const upPort = await freePort();
  const routerPort = await freePort();

  // Mock JEV: image if the state text mentions drawing/fox, else other.
  const jev = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const j = JSON.parse(b);
      const isImage = /fox|draw|image|picture/i.test(j.state || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choice: isImage ? 'image' : 'other', probabilities: [isImage ? 0.99 : 0.01] }));
    });
  });
  await new Promise((r) => jev.listen(jevPort, '127.0.0.1', r));

  // Mock upstream: records the last /api/agents/chat body it received.
  let lastUpstream = null;
  const upstream = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      lastUpstream = { url: req.url, body: JSON.parse(b || '{}') };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));

  const { handler } = loadServer({
    RECEPTIONIST_ID: RECEPTIONIST,
    ROUTER_AGENT_ID: IMAGE_CREATOR,
    ROUTER_THRESHOLD: '0.5',
    JEV_BASE: 'http://127.0.0.1:' + jevPort,
    JEV_PATH: '/upstream/jev-9b/v1/decide',
    UPSTREAM_HOST: '127.0.0.1',
    UPSTREAM_PORT: String(upPort),
    PORT: String(routerPort),
  });
  const router = await startRouter(handler, routerPort);
  t.after(() => { router.close(); jev.close(); upstream.close(); });

  // 1. Non-image message on Receptionist -> stays on Receptionist/Spark.
  await post(routerPort, { conversationId: 'new', agent_id: RECEPTIONIST, text: 'what is 2 plus 2?' });
  assert.strictEqual(lastUpstream.body.agent_id, RECEPTIONIST, 'non-image should stay on Spark');

  // 2. Image message on Receptionist -> rewritten to Image Creator.
  await post(routerPort, { conversationId: 'new', agent_id: RECEPTIONIST, text: 'draw a blue fox' });
  assert.strictEqual(lastUpstream.body.agent_id, IMAGE_CREATOR, 'image should route to Image Creator');
  assert.strictEqual(lastUpstream.body.endpoint, 'agents');

  // 3. Non-image message now on Image Creator (client rebound) -> rewritten back to Receptionist/Spark.
  await post(routerPort, { conversationId: 'abc', agent_id: IMAGE_CREATOR, text: 'tell me a fun fact' });
  assert.strictEqual(lastUpstream.body.agent_id, RECEPTIONIST, 'non-image on Image Creator should swap back to Spark');
});

test('handler passes through non-managed agents unchanged (integration)', async (t) => {
  const upPort = await freePort();
  const routerPort = await freePort();
  let lastUpstream = null;
  const upstream = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      lastUpstream = JSON.parse(b || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));

  const { handler } = loadServer({
    RECEPTIONIST_ID: RECEPTIONIST,
    ROUTER_AGENT_ID: IMAGE_CREATOR,
    JEV_BASE: 'http://127.0.0.1:1', // unused: non-managed agents never call JEV
    UPSTREAM_HOST: '127.0.0.1',
    UPSTREAM_PORT: String(upPort),
    PORT: String(routerPort),
  });
  const router = await startRouter(handler, routerPort);
  t.after(() => { router.close(); upstream.close(); });

  await post(routerPort, { conversationId: 'new', agent_id: 'agent_some_other', text: 'draw a fox' });
  assert.strictEqual(lastUpstream.agent_id, 'agent_some_other', 'non-managed agent must pass through unchanged');
});
