// Observability (TODO.api/10): one structured-log face and one Analytics
// Engine write per served request. Both are fail-soft — observability must
// never turn a good response into a 500 — and both no-op when the binding
// is absent, so tests and un-configured deployments run without them.
import type { Env } from "../env";

export interface RequestObservation {
  route: string;
  method: string;
  status: number;
  ms: number;
  flavor?: string | null;
  key?: string | null;
  cacheHit?: boolean;
}

export function recordRequest(env: Env, obs: RequestObservation): void {
  const dataset = (env as { AE?: AnalyticsEngineDataset }).AE;
  if (!dataset) return;
  // Index: route (the aggregation key). Blobs: method + key/flavor context.
  // Doubles: status, duration (ms).
  try {
    dataset.writeDataPoint({
      indexes: [obs.route],
      blobs: [obs.method, obs.key ?? "", obs.flavor ?? ""],
      doubles: [obs.status, Math.round(obs.ms)],
    });
  } catch (e) {
    console.error(JSON.stringify({ event: "ae_write_failed", route: obs.route, error: String(e) }));
  }
}

// Structured log line — one JSON object per event, greppable in
// `wrangler tail --format json` and the Workers Logs UI. R2 misses are
// the alert-worthy event (they should sit at ~0 once a flavor is
// ingested); everything else is trace-grade.
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
