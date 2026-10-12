// Runs the compatibility battery INSIDE a real Durable Object (needs the local Cloudflare runtime: see README.md in this folder).
import { DoD1Database } from "../../worker/src/storage/do-d1";
import { battery } from "./battery";
export class TestObject {
  constructor(private ctx: any, private env: unknown) {}
  async fetch(_request: Request): Promise<Response> {
    return Response.json(await battery(new DoD1Database(this.ctx.storage.sql, this.ctx.storage)));
  }
}
export default { async fetch(request: Request, env: any): Promise<Response> { return env.TEST.get(env.TEST.idFromName("x")).fetch(request); } };
