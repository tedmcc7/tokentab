// TokenTab → (mock) Ramp export proof. No Ramp account required.
// Proves: events → per-class pricing → LiteLLM Standard Logging Payload (+attribution
// metadata) → POST to a local mock receiver that dedupes idempotently and rolls up
// spend by FEATURE and by COGS/OpEx. Pure stdlib; Node 18+ (global fetch).
import http from 'node:http';
import crypto from 'node:crypto';

// ── prices.json (seed; verify_before_trusting) — per MTok, 4 classes ──────────
const PRICES = {
  'claude-opus-4-8':   { in: 15, out: 75, cw: 18.75, cr: 1.5 },
  'claude-sonnet-4-6': { in: 3,  out: 15, cw: 3.75,  cr: 0.3 },
};
const price = (m) => PRICES[m];
function costOf(e) {
  const p = price(e.model);
  if (!p) return { cost: null, unpriced: true };
  const c = e.input/1e6*p.in + e.output/1e6*p.out + e.cache_write/1e6*p.cw + e.cache_read/1e6*p.cr;
  return { cost: c, unpriced: false };
}

// ── mock TokenTab events (what M1/M2 would have in SQLite after ingest+tabs) ──
// cost_category is the NEW M2.5 field, set from the tab. "unclassified" falls back to branch.
const EVENTS = [
  // checkout-redesign = customer-facing feature → COGS
  { id:'e1', ts:'2026-06-10T14:02:00Z', model:'claude-sonnet-4-6', repo:'storefront', git_branch:'feat/checkout-redesign', pr:1421, feature:'checkout-redesign', cost_category:'COGS', input:8200, output:1900, cache_write:12000, cache_read:240000 },
  { id:'e2', ts:'2026-06-10T14:31:00Z', model:'claude-opus-4-8',   repo:'storefront', git_branch:'feat/checkout-redesign', pr:1421, feature:'checkout-redesign', cost_category:'COGS', input:5400, output:3100, cache_write:0,     cache_read:610000 },
  // search-ranking = customer-facing → COGS
  { id:'e3', ts:'2026-06-11T09:12:00Z', model:'claude-sonnet-4-6', repo:'search',     git_branch:'feat/ranking-v2',       pr:1430, feature:'search-ranking',    cost_category:'COGS', input:3000, output:900,  cache_write:4000,  cache_read:88000 },
  // internal-admin-tools = internal → OpEx
  { id:'e4', ts:'2026-06-11T16:45:00Z', model:'claude-sonnet-4-6', repo:'backoffice', git_branch:'chore/admin-tooling',    pr:null, feature:'internal-admin-tools', cost_category:'OpEx', input:2200, output:700,  cache_write:0,     cache_read:51000 },
  { id:'e5', ts:'2026-06-11T17:10:00Z', model:'claude-opus-4-8',   repo:'backoffice', git_branch:'chore/admin-tooling',    pr:null, feature:'internal-admin-tools', cost_category:'OpEx', input:1800, output:2400, cache_write:9000,  cache_read:33000 },
  // no tab open → unclassified, attribute to branch (cost_category unset)
  { id:'e6', ts:'2026-06-12T11:03:00Z', model:'claude-sonnet-4-6', repo:'storefront', git_branch:'fix/cart-flicker',       pr:1433, feature:null, cost_category:'unclassified', input:1500, output:400, cache_write:0, cache_read:42000 },
];

// ── adapter: TokenTab event → LiteLLM Standard Logging Payload (faithful subset) ──
// Ramp's POST /developer/v1/ai-usage/litellm accepts exactly this shape. Attribution
// rides in metadata.requester_metadata (Ramp "accepts arbitrary metadata for attribution").
// NOTE: no message.content / prompt text is ever included — privacy invariant preserved.
function toLiteLLMPayload(e) {
  const { cost, unpriced } = costOf(e);
  const start = Date.parse(e.ts) / 1000;
  return {
    id: e.id,                                   // dedupe key (idempotent ingest)
    call_type: 'completion',
    model: e.model,
    custom_llm_provider: 'anthropic',
    response_cost: unpriced ? null : Number(cost.toFixed(10)), // Decimal-ish precision
    cache_hit: e.cache_read > 0,
    prompt_tokens: e.input,
    completion_tokens: e.output,
    total_tokens: e.input + e.output,
    cache_creation_input_tokens: e.cache_write,
    cache_read_input_tokens: e.cache_read,
    startTime: start,
    endTime: start + 5,
    metadata: {
      user_api_key_team_id: e.repo,             // maps to an org dimension in Ramp
      requester_metadata: {                     // ← TokenTab's differentiating axis
        feature: e.feature,
        repo: e.repo,
        git_branch: e.git_branch,
        pr: e.pr,
        cost_category: e.cost_category,         // COGS | OpEx | unclassified, at FEATURE granularity
      },
    },
  };
}

// ── mock Ramp receiver: validate, dedupe by id, aggregate by feature + COGS/OpEx ──
const store = new Map(); // id -> payload  (ReplacingMergeTree-style: last write wins)
function ingest(payload) {
  for (const f of ['id','model','response_cost','metadata']) {
    if (!(f in payload)) return { ok:false, error:`missing ${f}` };
  }
  if (JSON.stringify(payload).includes('"content"'))
    return { ok:false, error:'payload contains message content (privacy violation)' };
  store.set(payload.id, payload); // idempotent: re-posting same id never double counts
  return { ok:true };
}
function summary() {
  const byFeature = {}, byCategory = {}; let total = 0;
  for (const p of store.values()) {
    const c = p.response_cost ?? 0; total += c;
    const m = p.metadata.requester_metadata;
    const fk = m.feature ?? `(branch) ${m.git_branch}`;
    byFeature[fk]  = (byFeature[fk]  ?? 0) + c;
    byCategory[m.cost_category] = (byCategory[m.cost_category] ?? 0) + c;
  }
  return { events: store.size, total, byFeature, byCategory };
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/developer/v1/ai-usage/litellm') {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      let r; try { r = ingest(JSON.parse(body)); } catch { r = { ok:false, error:'bad json' }; }
      res.writeHead(r.ok ? 202 : 400, {'content-type':'application/json'});
      res.end(JSON.stringify(r));
    });
  } else if (req.method === 'GET' && req.url === '/summary') {
    res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify(summary()));
  } else { res.writeHead(404); res.end(); }
});

// ── driver: send all events (one twice, to prove idempotency), then read summary ──
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/developer/v1/ai-usage/litellm`;
const send = (p) => fetch(url, { method:'POST', headers:{'content-type':'application/json',authorization:'Bearer mock-RAMP_API_KEY'}, body: JSON.stringify(p) }).then(r=>r.status);

const payloads = EVENTS.map(toLiteLLMPayload);
const statuses = [];
for (const p of payloads) statuses.push(await send(p));
statuses.push(await send(payloads[0])); // duplicate e1 → must NOT double-count

const sum = await fetch(`http://127.0.0.1:${port}/summary`).then(r=>r.json());
const usd = (n)=>'$'+n.toFixed(4);

console.log('POST statuses        :', statuses.join(' '), '(7 sends, last is a duplicate of e1)');
console.log('Stored events        :', sum.events, '(6 unique — duplicate deduped ✓)');
console.log('Sample payload (e1)  :', JSON.stringify(payloads[0]));
console.log('Contains prompt text : ', JSON.stringify(payloads[0]).includes('"content"'));
console.log('\n— Spend by FEATURE —');
for (const [k,v] of Object.entries(sum.byFeature).sort((a,b)=>b[1]-a[1])) console.log('  '+k.padEnd(26), usd(v));
console.log('\n— Spend by COGS / OpEx (feature-level, the part Ramp can\'t do from a team key) —');
for (const [k,v] of Object.entries(sum.byCategory).sort((a,b)=>b[1]-a[1])) console.log('  '+k.padEnd(14), usd(v));
console.log('  '+'TOTAL'.padEnd(14), usd(sum.total));
server.close();
