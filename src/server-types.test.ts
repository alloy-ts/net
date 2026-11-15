import { expect, test } from "vite-plus/test";
import * as native from "../dist/index.js";
import { Server, type Context, type Env } from "./main.ts";

test("set and get share request variables", async () => {
  const server = new Server();
  server.use("/auth/*", async (c, next) => {
    c.set("user", c.env?.TOKEN);
    await next();
  });
  server.get("/auth/me", (c) => c.text(String(c.get("user"))));
  expect(
    await (await server.fetch(new Request("http://localhost/auth/me"), { TOKEN: "s" })).text(),
  ).toBe("s");
  expect(server).toBeInstanceOf(Server);
});

test("the typed facade is the native constructor, not a wrapper", () => {
  expect(Server).toBe(native.Server);
  expect(new Server()).toBeInstanceOf(native.Server);
});

interface AppEnv extends Env {
  Bindings: { TOKEN: string };
  Variables: { user: string };
}

test("Server<E> types bindings, variables, Context and fetch/request results", async () => {
  const server = new Server<AppEnv>({ port: 0, strict: false, host: "127.0.0.1" });

  // These are compile-time assertions: `vp check` fails if any member regresses
  // to `unknown`, or if the generic shape is lost.
  server.get("/typed/:id", (c, next) => {
    const token: string = c.env.TOKEN;
    const page: string | undefined = c.req.query("page");
    const id: string | undefined = c.req.param("id");
    const allParams: Record<string, string> = c.req.param();
    const method: string = c.req.method;
    const url: string = c.req.url;
    const chained: Context<AppEnv> = c.status(202).header("x-token", token);
    c.set("user", token);
    const user: string | undefined = c.get("user");
    void next;
    void page;
    void id;
    void allParams;
    void method;
    void url;
    void chained;
    return c.text(user ?? "");
  });

  const fromRequest: Promise<Response> = server.request("/typed/7");
  const fromFetch: Promise<Response> = server.fetch(new Request("http://localhost/typed/7"), {
    TOKEN: "s",
  });
  const port: Promise<number> = server.start();
  void port;
  void fromRequest;
  void fromFetch;

  expect(server).toBeInstanceOf(Server);
  expect(typeof server.listening).toBe("boolean");
});
