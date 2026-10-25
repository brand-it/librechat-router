'use strict';
// librechat-router: reverse proxy in front of librechat-api. For messages on the
// two managed agents (Receptionist and Image Creator) it asks JEV-9B, per
// message, whether the user wants an image, and rewrites the request to target
// the matching agent: image -> Image Creator, otherwise -> Receptionist (which
// answers on the standard Spark model). This lets one conversation swap models
// message-by-message in both directions. The client re-binds the conversation
// to whichever agent answered, so the server-side rewrite drives the swap. Any
// other agent is left alone. Fails open (forwards unchanged) on any JEV error
// or timeout, so chat never breaks.
const http = require('http');

const PORT = parseInt(process.env.PORT || '3081', 10);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'librechat-api';
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || '3080', 10);
const JEV_BASE = process.env.JEV_BASE || 'http://192.168.50.106:8081';
const JEV_PATH = process.env.JEV_PATH || '/upstream/jev-9b/v1/decide';
const ROUTER_AGENT_ID = process.env.ROUTER_AGENT_ID || 'agent_hgrCkcWQEk8znW4L5zoMe';
const ROUTER_AGENT_MODEL = process.env.ROUTER_AGENT_MODEL || 'qwen38-27b-nvfp4-single-node';
const RECEPTIONIST_ID = process.env.RECEPTIONIST_ID || 'agent_3fs4vNxAoN9duaGKlwObE';
const ROUTER_THRESHOLD = parseFloat(process.env.ROUTER_THRESHOLD || '0.5');
const JEV_TIMEOUT_MS = parseInt(process.env.JEV_TIMEOUT_MS || '10000', 10);
// Validated 100% on the 28-case image-vs-other routing set.
const INSTRUCTIONS =
  'Route this message. image = user wants to generate or edit an image. '
  + 'other = anything else (questions, code, chat, tasks).';
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);
function log(...args) {
  process.stdout.write('[' + new Date().toISOString() + '] ' + args.join(' ') + '\n');
}
// True when the request targets one of the two agents the router manages.
function isManagedAgent(agentId) {
  return agentId === RECEPTIONIST_ID || agentId === ROUTER_AGENT_ID;
}
// Pure routing decision: given a JEV-9B decision, which agent should answer.
// image (or pImage above threshold) -> Image Creator, otherwise Receptionist/Spark.
function resolveTarget(agentId, d) {
  const wantImage = !!(d && (d.choice === 'image' || d.pImage > ROUTER_THRESHOLD));
  return wantImage ? ROUTER_AGENT_ID : RECEPTIONIST_ID;
}
// Ask JEV-9B to classify the message. Resolves {choice, pImage} or null on failure.
function decide(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      kind: 'choice',
      state: text,
      question: INSTRUCTIONS,
      options: ['image', 'other'],
      thinking: 'off',
    });
    const u = new URL(JEV_BASE + JEV_PATH);
    const req = http.request({
      host: u.hostname,
      port: u.port || 80,
      path: JEV_PATH,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          const pImage = Array.isArray(d.probabilities) ? d.probabilities[0] : 0;
          resolve({ choice: d.choice, pImage });
        } catch (e) {
          log('decide: bad JSON', e.message, data.slice(0, 160));
          resolve(null);
        }
      });
    });
    req.setTimeout(JEV_TIMEOUT_MS, () => {
      log('decide: timeout after', JEV_TIMEOUT_MS + 'ms');
      req.destroy();
      resolve(null);
    });
    req.on('error', (e) => {
      log('decide: error', e.message);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}
function cleanReqHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  out.host = h.host || 'chat.lareaus.com';
  return out;
}
function cleanResHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}
function upstreamError(res, e) {
  log('upstream error', e.message);
  if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'upstream unavailable', detail: e.message }));
}
// Plain pass-through: pipe the request body straight to librechat-api.
function pipeThrough(req, res) {
  const upReq = http.request({
    host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: req.url, method: req.method,
    headers: cleanReqHeaders(req.headers),
  }, (upRes) => {
    res.writeHead(upRes.statusCode, cleanResHeaders(upRes.headers));
    upRes.pipe(res);
  });
  upReq.on('error', (e) => upstreamError(res, e));
  req.pipe(upReq);
}
// Managed-agent POST /api/agents/chat: buffer, ask JEV per message, maybe swap
// the target agent, forward.
async function handleChat(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks);
    let parsed = null;
    if (rawBody.length) {
      try { parsed = JSON.parse(rawBody.toString('utf8')); } catch (e) { /* not json */ }
    }
    let forwardBody = rawBody;
    const rawText = (typeof parsed?.text === 'string' && parsed.text.trim() !== '')
      ? parsed.text
      : (typeof parsed?.message === 'string' && parsed.message.trim() !== '')
        ? parsed.message
        : null;
    const isEligible = parsed
      && isManagedAgent(parsed.agent_id)
      && rawText !== null;
    if (isEligible) {
      const text = rawText;
      const fromName = parsed.agent_id === RECEPTIONIST_ID ? 'Receptionist' : 'Image Creator';
      log('route msg conv=' + (parsed.conversationId || 'new') + ' from=' + fromName + ' ' + JSON.stringify(text.slice(0, 80)));
      const d = await decide(text);
      const target = resolveTarget(parsed.agent_id, d);
      const targetName = target === ROUTER_AGENT_ID ? 'Image Creator' : 'Receptionist/Spark';
      const detail = 'choice=' + (d ? d.choice : 'n/a') + ', pImage=' + (d ? d.pImage.toFixed(3) : 'n/a') + ', thr=' + ROUTER_THRESHOLD;
      if (parsed.agent_id === target) {
        log('route -> ' + targetName + ' (already on target; ' + detail + ')');
      } else {
        log('route -> ' + targetName + ' (rewriting from ' + fromName + '; ' + detail + ')');
        const out = Object.assign({}, parsed);
        out.endpoint = 'agents';
        out.agent_id = target;
        delete out.spec;
        delete out.model;
        delete out.endpointType;
        forwardBody = Buffer.from(JSON.stringify(out));
      }
    } else {
      log('pass through ' + req.url + ' (not a managed-agent message)');
    }
    const headers = cleanReqHeaders(req.headers);
    headers['content-length'] = forwardBody.length;
    const upReq = http.request({
      host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: req.url, method: req.method,
      headers,
    }, (upRes) => {
      res.writeHead(upRes.statusCode, cleanResHeaders(upRes.headers));
      upRes.pipe(res);
    });
    upReq.on('error', (e) => upstreamError(res, e));
    upReq.write(forwardBody);
    upReq.end();
  });
}
const handler = (req, res) => {
  const p = req.url.split('?')[0];
  if (req.method === 'POST' && (p === '/api/agents/chat' || p.startsWith('/api/agents/chat/'))) {
    handleChat(req, res);
  } else {
    pipeThrough(req, res);
  }
};
const server = http.createServer(handler);
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    log('librechat-router listening on :' + PORT + ' -> ' + UPSTREAM_HOST + ':' + UPSTREAM_PORT);
    log('JEV: ' + JEV_BASE + JEV_PATH + ' | agent=' + ROUTER_AGENT_ID + ' | threshold=' + ROUTER_THRESHOLD + ' | timeout=' + JEV_TIMEOUT_MS + 'ms');
  });
}
module.exports = { handler, isManagedAgent, resolveTarget, server };
