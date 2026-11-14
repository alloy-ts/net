# Cloudflare Worker runbook

The `alloy-net` Worker (`src/worker.ts`, `wrangler.toml`) puts net behind
Cloudflare's edge. It does **not** run the Rust server: Workers have no N-API,
Tokio or sockets, and `Server` dispatch in `src/server.rs` is built on napi
ThreadsafeFunctions and Rocket. Rust on Workers only runs as wasm, and
porting dispatch to wasm would mean re-implementing the middleware chain and
context outside napi. So the Worker:

- answers `GET`/`HEAD /health` itself (`200 ok`, `cache-control: no-store`);
- forwards every other request (any method, path, query, headers and streamed
  body) to the net origin in `ORIGIN_URL`, and returns its response with
  redirects unfollowed;
- drops hop-by-hop headers and sets `X-Forwarded-Host`, `X-Forwarded-Proto`
  and `X-Forwarded-For` (from `CF-Connecting-IP`).

Errors from the Worker itself: `503` when `ORIGIN_URL` is unset, not http(s)
or still the `https://origin.invalid` placeholder; `508` when it points back at
the Worker's own host; `502` when the origin cannot be reached.

## Route parity

| Route (examples/server.ts, deploy/server.mjs)                                                  | Through the Worker                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health`                                                                                  | Served by the Worker; no origin call                                                                                                                                                                                                       |
| `GET /ping`, `/posts/:id`, `/page`, `/status`, `/raw`, `/books/:id`, `/v2/ping`, `/boom`, 404s | Proxied, same status and body                                                                                                                                                                                                              |
| `POST /posts` (JSON body)                                                                      | Proxied, body streamed                                                                                                                                                                                                                     |
| `GET /go` (302)                                                                                | Proxied; `Location` passed back, not followed                                                                                                                                                                                              |
| `/admin/*` middleware                                                                          | Proxied; same 401 as direct (Bindings are per-request in-process only)                                                                                                                                                                     |
| `QUERY`, `PURGE`                                                                               | The Worker forwards them (verified in `wrangler dev`), but Rocket 0.5 answers 400, the same as calling the origin directly. Cloudflare's edge may also reject non-standard methods before the Worker runs; not verified without an account |
| WebSocket upgrades                                                                             | Not supported (net has none; `Upgrade` is stripped)                                                                                                                                                                                        |

## What Yumin supplies

1. A Cloudflare account. Either run `npx wrangler@4.162.0 login` on your own
   machine, or create an API token with the **Edit Cloudflare Workers**
   template and export it in your shell only (never commit it):
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
2. The origin URL. It must be reachable from the public internet:
   - Cloud Run: the service URL, e.g. `https://net-xxxx-ew.a.run.app`.
   - Mac mini on Tailscale: Workers cannot reach tailnet (100.x / `*.ts.net`
     private) addresses. Use `tailscale funnel` to publish it, or a
     Cloudflare Tunnel (`cloudflared`) and point `ORIGIN_URL` at that hostname.
3. A domain (optional). Without one the Worker is at
   `https://alloy-net.<account-subdomain>.workers.dev`.

The origin is public either way. Until net checks a shared secret, anyone who
learns `ORIGIN_URL` can bypass the Worker.

## Local check

```sh
npm ci
npm run build                      # only needed to run a local net origin
PORT=3999 node --import @oxc-node/core/register examples/server.ts &
npm run worker:dev -- --var ORIGIN_URL:http://127.0.0.1:3999
curl -i http://127.0.0.1:8787/health
curl -i http://127.0.0.1:8787/ping
npm run worker:check               # deploy --dry-run, prints the bundle size
```

Local-only vars can also go in `.dev.vars` (ignored by git).

## Deploy

```sh
npx wrangler@4.162.0 whoami        # confirms the account
npm run worker:deploy -- --var ORIGIN_URL:https://net-xxxx-ew.a.run.app
```

Or set `ORIGIN_URL` in `wrangler.toml` `[vars]` (it is not a secret), or under
Workers & Pages > alloy-net > Settings > Variables in the dashboard. Note that
`wrangler deploy` overwrites dashboard vars with the ones in `wrangler.toml`
unless `keep_vars = true` is added.

## Custom domain or route

The zone must be on the same Cloudflare account. In `wrangler.toml`, uncomment
one of:

```toml
# Worker owns the whole hostname; Cloudflare creates the DNS record and cert.
routes = [{ pattern = "net.example.com", custom_domain = true }]

# Or only a path on an existing proxied hostname.
routes = [{ pattern = "example.com/api/*", zone_name = "example.com" }]
```

then `npm run worker:deploy`. A custom domain fails if the hostname already has
a DNS record; delete it first. To keep only the custom domain, set
`workers_dev = false`.

## Rollback

`npx wrangler@4.162.0 deployments list`, then
`npx wrangler@4.162.0 rollback <version-id>`, or delete the Worker with
`npx wrangler@4.162.0 delete`.
