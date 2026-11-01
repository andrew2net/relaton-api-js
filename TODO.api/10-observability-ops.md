# 10 — Observability and operations

Status (2026-11-01): shipped in-repo — the `AE` Analytics Engine binding
(dataset `relaton_api_requests`, per-response datapoint: route label
index; method/key/flavor blobs; status+ms doubles), structured JSON logs
(`r2_miss` is the alert event, `route_unmatched` covers surface gaps),
the optional `RATE_LIMITER` binding guard on public write endpoints
(documented wrangler snippet to enable), and the README runbook
(rollback, re-ingest, ADMIN_TOKEN rotation, D1 export) + status section
(/v3/flavors as the public health signal). Ops-side activation — the
dashboard link, a cron'd D1 export workflow, and enabling the
rate-limit binding on the account — is the deployment repo's call.

Goal: production visibility and boring, documented ops.

## Tasks

- [ ] Workers Analytics Engine: queries/s, cache hit ratio (edge vs D1),
      p50/p95 latency per route; simple dashboard link in README.
- [ ] Structured logs (wrangler tail JSON) with key/flavor fields; alert on
      R2-miss rate (should be ~0 after ingest).
- [ ] Rate limiting: Cloudflare WAF rule or Workers rate-limit binding,
      generous public defaults; documented.
- [ ] Runbooks: rollback (delete Workers route id 823ce284…), re-ingest a
      flavor (post_chunks markers), rotate ADMIN_TOKEN (wrangler secret +
      gh secret), D1 backup/export schedule.
- [ ] Status page section in README: /v3/flavors as the public health
      signal (index versions + counts).

## Acceptance

- Cache-hit ratio visible and >80% steady-state; on-call actions are
  copy-paste from the runbook.
