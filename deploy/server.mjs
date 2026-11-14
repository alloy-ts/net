/**
 * Minimal production entry for the container image.
 * Uses the packed native addon, not the TypeScript sources.
 */
import { RegExpRouter, Server } from "../dist/index.mjs";

function parsePort(raw) {
  if (raw === undefined || raw === "") {
    return 3000;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer 1-65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

function parseHost(raw) {
  const host = raw === undefined || raw === "" ? "0.0.0.0" : raw;
  if (host === "localhost") {
    return "127.0.0.1";
  }
  return host;
}

function listenUrl(host, port) {
  const authority = host.includes(":") ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}

const port = parsePort(process.env.PORT);
const host = parseHost(process.env.HOST);

const app = new Server({
  router: new RegExpRouter(),
  port,
  host,
});
app.get("/health", (c) => c.text("ok"));
app.get("/ping", (c) => c.text("pong"));

const bound = await app.start();
console.log(`listening on ${listenUrl(app.host, bound)}`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log(`received ${signal}, stopping`);
  const timeout = setTimeout(() => {
    console.error("shutdown timed out");
    process.exit(1);
  }, 15_000);
  timeout.unref();
  try {
    await app.stop();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
