export * from "../dist/index.js";
export { Request, Headers, fetch } from "./request.ts";
export type { RequestOpts, RequestInit } from "./request.ts";
export { Response } from "./response.ts";
export type { ResponseInit } from "./response.ts";
export { File, Blob } from "./fs/file.ts";
// Node adapters preserve EventEmitter, stream, callback, and error semantics.
export * as net from "node:net";
export * as http from "node:http";
export * as fs from "node:fs";
export {
  Socket,
  Server as NetServer,
  createServer as createNetServer,
  connect as connectSocket,
} from "node:net";
export {
  IncomingMessage,
  ServerResponse,
  Server as HttpServer,
  createServer as createHttpServer,
} from "node:http";
