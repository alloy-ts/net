/**
 * Minimal production entry for the container image.
 * Uses the packed native addon, not the TypeScript sources.
 */
import { RegExpRouter, Server } from "../dist/index.mjs";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`PORT must be an integer 0-65535, got ${JSON.stringify(process.env.PORT)}`);
}

const app = new Server({
  router: new RegExpRouter(),
  port,
  host,
});
app.get("/health", (c) => c.text("ok"));
app.get("/ping", (c) => c.text("pong"));

const bound = await app.start();
console.log(`listening on http://${app.host}:${bound}`);

async function shutdown(signal) {
  console.log(`received ${signal}, stopping`);
  try {
    await app.stop();
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
