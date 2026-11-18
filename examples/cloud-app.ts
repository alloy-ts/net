import { createApp } from "../src/cloud.ts";

/** Shared by the local listener and cloud runtime adapters. */
export const app = createApp({
  routes: {
    "/health": () => Response.json({ ok: true }),
    "/data": () => Response.json({ source: "portable" }),
  },
});
