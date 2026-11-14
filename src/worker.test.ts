import { describe, expect, test } from "vite-plus/test";
import { handle, originOf, targetFor } from "./worker.ts";

const env = { ORIGIN_URL: "https://origin.example/base/" };

function recorder() {
  const seen: Request[] = [];
  const upstream = async (request: Request) => {
    seen.push(request);
    const body = request.body ? await request.text() : "";
    return new Response(`${request.method} ${new URL(request.url).pathname} ${body}`, {
      status: 201,
      headers: { "x-origin": "1" },
    });
  };
  return { seen, upstream };
}

describe("Cloudflare Worker entry", () => {
  test("/health answers without calling the origin", async () => {
    const { seen, upstream } = recorder();
    const response = await handle(new Request("https://edge.example/health"), {}, upstream);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    const head = await handle(
      new Request("https://edge.example/health", { method: "HEAD" }),
      {},
      upstream,
    );
    expect(head.status).toBe(200);
    expect(seen).toHaveLength(0);
  });

  test("other routes go to ORIGIN_URL with path, query, method and body", async () => {
    const { seen, upstream } = recorder();
    const response = await handle(
      new Request("https://edge.example/posts?x=1", {
        method: "POST",
        headers: { "content-type": "application/json", connection: "keep-alive" },
        body: '{"title":"note"}',
      }),
      env,
      upstream,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("x-origin")).toBe("1");
    expect(await response.text()).toBe('POST /base/posts {"title":"note"}');
    const forwarded = seen[0]!;
    expect(forwarded.url).toBe("https://origin.example/base/posts?x=1");
    expect(forwarded.headers.get("x-forwarded-host")).toBe("edge.example");
    expect(forwarded.headers.get("x-forwarded-proto")).toBe("https");
    expect(forwarded.headers.get("connection")).toBeNull();
    expect(forwarded.redirect).toBe("manual");
  });

  test("custom methods such as QUERY pass through", async () => {
    const { upstream } = recorder();
    const response = await handle(
      new Request("https://edge.example/search", { method: "QUERY", body: "q" }),
      env,
      upstream,
    );
    expect(await response.text()).toBe("QUERY /base/search q");
  });

  test("missing, placeholder, looping and unreachable origins", async () => {
    const { upstream } = recorder();
    const ping = () => new Request("https://edge.example/ping");
    expect((await handle(ping(), {}, upstream)).status).toBe(503);
    expect((await handle(ping(), { ORIGIN_URL: "https://origin.invalid" }, upstream)).status).toBe(
      503,
    );
    expect((await handle(ping(), { ORIGIN_URL: "ftp://origin.example" }, upstream)).status).toBe(
      503,
    );
    expect((await handle(ping(), { ORIGIN_URL: "https://edge.example" }, upstream)).status).toBe(
      508,
    );
    const failing = async () => {
      throw new Error("down");
    };
    expect((await handle(ping(), env, failing)).status).toBe(502);
  });

  test("origin parsing and path joining", () => {
    expect(originOf({ ORIGIN_URL: " not a url " })).toBeUndefined();
    const origin = originOf({ ORIGIN_URL: "http://127.0.0.1:3000" })!;
    expect(targetFor(origin, new URL("https://edge.example/a/b?c=d#e")).href).toBe(
      "http://127.0.0.1:3000/a/b?c=d",
    );
  });
});
