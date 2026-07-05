export interface Env {
  OFFICE_DB: D1Database;
  OFFICE_VAULT: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Milestone 1 on the backend side mirrors milestone 1 on the
    // Flutter side: prove the pipeline (git push -> deploy -> live),
    // not a feature. Real action functions (job.create, invoice.create,
    // etc.) and guard() come after this is proven, per the agreed build
    // order — memory/vectorize comes last, deliberately.
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ status: "ok", service: "office-api" });
    }

    if (url.pathname.startsWith("/auth")) {
      return new Response("auth: reserved, not yet implemented", { status: 501 });
    }

    if (url.pathname.startsWith("/files")) {
      return new Response("files: reserved, not yet implemented", { status: 501 });
    }

    return new Response("not found", { status: 404 });
  },
};
