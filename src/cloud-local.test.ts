import { describe, expect, test } from "vite-plus/test";
import { app, localServer } from "../examples/cloud-function-local.ts";

describe("portable app on a local listener", () => {
  test("serves the same app directly and through Axum", async () => {
    const server = localServer();
    try {
      const port = await server.start();
      const direct = await app(new Request("http://localhost/health"));
      const local = await fetch(`http://127.0.0.1:${port}/health`);
      expect(local.status).toBe(direct.status);
      expect(await local.json()).toEqual(await direct.json());
      expect(await (await fetch(`http://127.0.0.1:${port}/data`)).json()).toEqual({
        source: "portable",
      });
    } finally {
      await server.stop();
    }
  });
});
