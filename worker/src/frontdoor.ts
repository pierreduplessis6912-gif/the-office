// The Worker's front door: nothing that goes wrong inside a request may escape as a bare, anonymous failure.
//
// Added 2026-10-11 (hardening). Before this, handleRequest had no outer try/catch: a route that threw (a database error in a route with no handling of its own,
// say) reached Cloudflare uncaught, which answers with its own generic error page: no CORS headers (so the app cannot even read it), no request id, and no
// log line that ties the failure to the request. Now every uncaught error is logged once with the request id, the method, the PATH (never the query string,
// which can carry a key or a name) and the stack, and the caller gets a small JSON 500 carrying the request id (so "it failed" can be traced to one log line)
// and nothing about what failed. A route that returns its own error response (a 403, a 404) is passed through untouched and is not logged here.
export type FrontDoorLog = (level: "info" | "error", requestId: string, message: string, fields?: Record<string, unknown>) => void;

export async function runGuarded(request: Request, requestId: string, run: () => Promise<Response> | Response, log: FrontDoorLog): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    let path = "";
    try {
      path = new URL(request.url).pathname;
    } catch {
      path = "(unreadable url)";
    }
    log("error", requestId, "unhandled error", { method: request.method, path, error: failure.message, stack: failure.stack });
    return Response.json({ error: "Something went wrong on our side. Please try again.", requestId }, { status: 500 });
  }
}
