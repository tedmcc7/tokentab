import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LiteLLMPayload } from '../types.js';

export type ReceiverBucket = {
  events: number;
  tokens: number;
  cost: number;
  unpriced: number;
};

export type ReceiverRollup = {
  total_received: number;
  total_deduped: number;
  unique_payloads: number;
  by_feature: Map<string, ReceiverBucket>;
  by_category: Map<string, ReceiverBucket>;
};

export type Receiver = {
  url: string;
  port: number;
  payloads(): LiteLLMPayload[];
  rollup(): ReceiverRollup;
  close(): Promise<void>;
};

export type ReceiverOptions = {
  port?: number;
  onPayload?: (payload: LiteLLMPayload, deduped: boolean) => void;
};

/**
 * Start a localhost HTTP receiver that accepts LiteLLM payloads via POST,
 * dedupes by `id`, and exposes the resulting rollup. Used by `tt export --mock`
 * and by the vitest "idempotent re-export" test.
 */
export function startReceiver(opts: ReceiverOptions = {}): Promise<Receiver> {
  const seen = new Map<string, LiteLLMPayload>();
  let totalReceived = 0;
  let totalDeduped = 0;

  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      let payload: LiteLLMPayload;
      try {
        payload = JSON.parse(body) as LiteLLMPayload;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, reason: 'bad_json' }));
        return;
      }
      if (typeof payload.id !== 'string' || payload.id.length === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, reason: 'missing_id' }));
        return;
      }
      totalReceived++;
      const wasSeen = seen.has(payload.id);
      if (wasSeen) totalDeduped++;
      seen.set(payload.id, payload);
      opts.onPayload?.(payload, wasSeen);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deduped: wasSeen }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        port: addr.port,
        payloads: () => Array.from(seen.values()),
        rollup: () => buildRollup(Array.from(seen.values()), totalReceived, totalDeduped),
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}

function emptyBucket(): ReceiverBucket {
  return { events: 0, tokens: 0, cost: 0, unpriced: 0 };
}

export function buildRollup(
  payloads: LiteLLMPayload[],
  totalReceived = payloads.length,
  totalDeduped = 0,
): ReceiverRollup {
  const by_feature = new Map<string, ReceiverBucket>();
  const by_category = new Map<string, ReceiverBucket>();

  for (const p of payloads) {
    const feature = p.metadata.requester_metadata.feature ?? '(untagged)';
    const category = p.metadata.requester_metadata.cost_category;
    const tokens = p.total_tokens;

    for (const [m, key] of [
      [by_feature, feature],
      [by_category, category],
    ] as const) {
      let bucket = m.get(key);
      if (!bucket) {
        bucket = emptyBucket();
        m.set(key, bucket);
      }
      bucket.events += 1;
      bucket.tokens += tokens;
      if (p.response_cost === null) bucket.unpriced += 1;
      else bucket.cost += p.response_cost;
    }
  }

  return {
    total_received: totalReceived,
    total_deduped: totalDeduped,
    unique_payloads: payloads.length,
    by_feature,
    by_category,
  };
}
