# Local and portable servers

The native `Server` listens with Axum. Its route and middleware API remains
available through `@alloy-ts/net`. Unlike the earlier Rocket listener, the
HTTP listener routes custom methods such as `QUERY` and `PURGE` as well as
in-process `request()` calls. Request bodies are bounded to 16 MiB. The
current native response bridge buffers the completed response before writing
it to HTTP; use a pure Fetch handler when a runtime needs streaming output.

## Local examples

Build the native package with `npm run build`, then run either example:

```sh
node --import @oxc-node/core/register examples/server.ts
node --import @oxc-node/core/register examples/server-static.ts
node --import @oxc-node/core/register examples/cloud-function-local.ts
```

`server-static.ts` serves `examples/static` by default, including JSON and
YAML fixtures. Pass a directory as the first argument and set `PORT` or
`HOST` to change the listener. The file handler checks the resolved path so
symlinks cannot escape the chosen directory.

`cloud-function-local.ts` hosts the portable app in `cloud-app.ts` through the
native server. The same app is exported from `cloud-function.ts` for a
Cloudflare Worker. The portable app and adapters are available from
`@alloy-ts/net/cloud`; this entry point imports neither Node APIs nor the
native addon. `lambda()`, `google()`, and `azure()` adapt the Fetch handler to
their respective HTTP function events. The native Axum listener itself runs
in a Rust/Node host and is not compiled into a Cloudflare Worker.

## MCP routes in a Rust host

Build with `cargo build --features mcp` to enable the optional `tower-mcp`
integration. `McpServer::new(mcp_router).into_router()` mounts streamable HTTP
at `/mcp` and WebSocket at `/mcp/ws` as an ordinary `axum::Router`. A Rust
host can pass it to `Server::start_with_router(...)` or call
`Server::start_with_mcp(...)`. Configure tool middleware with
`ToolBuilder::layer(...)`, transport middleware with `McpServer::http(...)`
and `McpServer::websocket(...)`, and HTTP middleware on the final Axum router.
The JavaScript `Server.start()` call does not install MCP routes.
