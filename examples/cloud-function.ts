/** Cloudflare Workers entry point for the same app run by cloud-function-local.ts. */
import { cloudflare } from "../src/cloud.ts";
import { app } from "./cloud-app.ts";

export default cloudflare(app);
