/**
 * Cloudflare Worker entry for alloy-net.
 *
 * Workers cannot load the N-API addon (no napi, Tokio or sockets), and the
 * Server dispatch in src/server.rs is built on napi ThreadsafeFunctions and
 * Rocket. So the Worker does not run the Rust server. It answers `/health`
 * itself and forwards every other request, unchanged, to the net origin named
 * by the `ORIGIN_URL` var (Cloud Run, or a public Tailscale Funnel URL).
 *
 * This file must not import ./main.ts or dist/: wrangler would try to bundle
 * the native addon. See deploy/CLOUDFLARE.md.
 */

/** Bindings declared in wrangler.toml. */
export interface WorkerEnv {
  /** Base URL of the net origin, e.g. https://net-abc123-ew.a.run.app */
  ORIGIN_URL?: string;
}

type Upstream = (input: Request) => Promise<Response>;

// RFC 9110 section 7.6.1 connection-specific fields, plus host, which the
// runtime sets from the target URL.
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
];

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Parses ORIGIN_URL; undefined when unset, unparsable, not http(s) or a `.invalid` placeholder. */
export function originOf(env: WorkerEnv): URL | undefined {
  const raw = env.ORIGIN_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.hostname === "invalid" || url.hostname.endsWith(".invalid")) return undefined;
  return url;
}

/** Joins the origin's base path with the incoming path and query. */
export function targetFor(origin: URL, incoming: URL): URL {
  const target = new URL(origin);
  const base = origin.pathname.replace(/\/+$/, "");
  target.pathname = `${base}${incoming.pathname}`;
  target.search = incoming.search;
  target.hash = "";
  return target;
}

export async function handle(
  request: Request,
  env: WorkerEnv,
  upstream: Upstream = (input) => fetch(input),
): Promise<Response> {
  const incoming = new URL(request.url);

  if (incoming.pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
    return text(request.method === "HEAD" ? "" : "ok", 200);
  }

  const origin = originOf(env);
  if (!origin) return text("origin not configured: set ORIGIN_URL", 503);
  if (origin.host === incoming.host) return text("ORIGIN_URL points back at this Worker", 508);

  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(/:$/, ""));
  const client = request.headers.get("cf-connecting-ip");
  if (client) headers.set("x-forwarded-for", client);

  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    redirect: "manual",
  };
  // Node's fetch requires duplex for a streamed body; workerd ignores it.
  if (hasBody) init.duplex = "half";

  let response: Response;
  try {
    response = await upstream(new Request(targetFor(origin, incoming), init));
  } catch {
    return text("origin unreachable", 502);
  }
  // Re-wrap so the headers are mutable for later middleware and the body streams through.
  return new Response(response.body, response);
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handle(request, env);
  },
};
