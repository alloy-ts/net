/** Serve the same portable app used by a cloud function on a local Axum listener. */
import { Server } from "../src/main.ts";
import type { App } from "../src/cloud.ts";
import { app } from "./cloud-app.ts";
export { app } from "./cloud-app.ts";

export function localServer(application: App = app, port = 0): Server {
  const server = new Server({ host: "127.0.0.1", port });
  const handle = (context: { req: { raw: Request } }) => application(context.req.raw);
  server.all("/", handle);
  server.all("/*", handle);
  return server;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const server = localServer(app, Number(process.env["PORT"] ?? 8080));
  const port = await server.start();
  console.log(`Portable app at http://127.0.0.1:${port}`);
  process.once("SIGINT", () => void server.stop());
  process.once("SIGTERM", () => void server.stop());
}
