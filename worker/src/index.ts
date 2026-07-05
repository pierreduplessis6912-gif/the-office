export interface Env {
  OFFICE_DB: D1Database;
  OFFICE_VAULT: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ status: "ok", service: "office-api" });
    }

    if (url.pathname.startsWith("/auth")) {
      return new Response("auth: reserved, not yet implemented", { status: 501 });
    }

    // First real use of /files and of OFFICE_VAULT. Just storage —
    // no D1 write here, no transcript, no action. Ground-truth state
    // (job.create, invoice.create, etc.) is a deliberately later step;
    // this only proves a voice note recorded on a real phone reaches
    // real object storage.
    if (url.pathname === "/files/audio" && request.method === "POST") {
      const formData = await request.formData();
      const audio = formData.get("audio");

      if (!(audio instanceof File)) {
        return Response.json({ error: "missing audio file" }, { status: 400 });
      }

      const key = `voice-notes/${Date.now()}-${crypto.randomUUID()}.m4a`;
      await env.OFFICE_VAULT.put(key, await audio.arrayBuffer());

      return Response.json({ status: "stored", key });
    }

    if (url.pathname.startsWith("/files")) {
      return new Response("files: reserved, not yet implemented", { status: 501 });
    }

    return new Response("not found", { status: 404 });
  },
};
