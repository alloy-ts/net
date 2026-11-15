/**
 * Compile-time assertions against the *generated* declarations.
 *
 * `Server` is re-exported straight from the NAPI loader (`../dist/index.js`
 * via `main.ts`). Its handler signatures, the inline `Context` shape and the
 * `fetch`/`request` return types all come from `#[napi(ts_args_type / ...)]`
 * overrides in `src/server.rs` — Rust is the only declaration source, and no
 * type is declared in TypeScript here.
 *
 * `vp check` only lints/formats and `tsconfig.json` excludes `*.test.ts`, so
 * these assertions are checked by `npm run check:types` (a real `tsc --noEmit`
 * over `tsconfig.types.json`). Vitest transpiles without type-checking.
 *
 * Every side-effecting call lives in `generatedDeclarationAssertions`, a
 * function that is never invoked. tsc still checks its body, but no request is
 * dispatched and no Rocket listener is started — `start()`, `serve()` and
 * `fire()` are never called, so this suite leaks no socket.
 */
import { expect, test } from "vite-plus/test";
import * as native from "../dist/index.js";
import { Response, Server } from "./main.ts";

function generatedDeclarationAssertions(): void {
  const server = new Server();

  // Chained registration with a typed context and `next`.
  server
    .get("/users/:id", async (c, next) => {
      const id: string | undefined = c.req.param("id");
      void id;
      await next();
      return c.json({ id });
    })
    .post("/users", (c) => c.text("created"));

  // The inline Context exposes typed members, not `unknown`/`any`.
  server.get("/ctx", (c) => {
    const all: Record<string, string> = c.req.param();
    const page: string | undefined = c.req.query("page");
    const method: string = c.req.method;
    const url: string = c.req.url;
    const env: Record<string, unknown> = c.env;
    const chained: typeof c = c.status(202).header("x-token", page ?? "");
    void all;
    void method;
    void url;
    void env;
    return chained.json({ ok: true });
  });

  // `use` accepts both a path and a bare middleware; `on` takes method lists.
  server.use("/auth/*", async (_c, next) => {
    await next();
  });
  server.use(async (_c, next) => {
    await next();
  });
  server.on("PURGE", "/cache", (c) => c.text("PURGE"));
  server.notFound((c) => c.text("missing", 404));
  server.onError((err, c) => c.text(String(err)));

  // Generated `ts_return_type`: fetch/request resolve to a web Response.
  const fromRequest: Promise<globalThis.Response> = server.request("/typed/7");
  const fromFetch: Promise<globalThis.Response> = server.fetch(
    new Request("http://localhost/typed/7"),
  );
  void fromRequest;
  void fromFetch;

  // The public Response facade is still constructible.
  new Response("ok");

  // -------------------------------------------------------------------------
  // Negative assertions. Each `@ts-expect-error` must stay *used*: if a member
  // regressed to `any`/`unknown`, the directive would be unused and tsc would
  // fail with TS2578. That is what makes these real assertions, not comments.
  // -------------------------------------------------------------------------

  // @ts-expect-error a path must be a string
  server.get(123);

  server.get("/nope", (c) => {
    // @ts-expect-error param() takes a string key, not a number
    c.req.param(42);
    return c.text("ok");
  });
}

// Arity is asserted at the type level so it cannot be defeated by a formatter
// reflowing a call across lines (an `@ts-expect-error` only covers the single
// next line). `Parameters<...>["length"]` is `2 | 3` for
// `path, handler, extra?`; a variadic `...middleware` would widen it to
// `number` and this assignment would fail to compile.
type RouteArgs = Parameters<Server["get"]>;
type RouteArity = RouteArgs["length"];
const routeArity: 2 | 3 = null as unknown as RouteArity;
void routeArity;

void generatedDeclarationAssertions;

test("Server is the native constructor, not a wrapper", () => {
  expect(Server).toBe(native.Server);
  expect(new Server()).toBeInstanceOf(native.Server);
});

test("the public Response facade is still constructible", () => {
  expect(new Response("ok")).toBeInstanceOf(globalThis.Response);
});
