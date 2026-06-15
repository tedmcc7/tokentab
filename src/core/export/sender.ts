import type { LiteLLMPayload } from '../types.js';

export type SendResult =
  | { ok: true; status: number; deduped: boolean }
  | { ok: false; status: number; error: string };

/**
 * POST one payload to the receiver. The receiver is expected to dedupe by
 * `payload.id`; if it returns `{ deduped: true }` in the body, we report that.
 */
export async function postPayload(url: string, payload: LiteLLMPayload): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }
  let deduped = false;
  try {
    const body = (await res.json()) as { deduped?: boolean };
    deduped = body.deduped === true;
  } catch {
    // Non-JSON response is fine — the receiver is allowed to return anything;
    // we only treat the status code as authoritative for ok/not-ok.
  }
  if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  return { ok: true, status: res.status, deduped };
}
