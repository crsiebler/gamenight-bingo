export function createWebHealthHandler(
  readinessCheck: () => Promise<boolean>,
): (request: Request) => Promise<Response> {
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
  return async (request) => {
    const url = new URL(request.url);
    if (url.search.length > 0 || (url.pathname !== "/healthz" && url.pathname !== "/readyz")) {
      return Response.json({ status: "not_found" }, { status: 404, headers });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json(
        { status: "method_not_allowed" },
        { status: 405, headers: { ...headers, allow: "GET, HEAD" } },
      );
    }

    const body =
      url.pathname === "/healthz"
        ? { status: "ok", service: "web" }
        : await readinessCheck().then(
            (ready) => ({
              status: ready ? "ready" : "not_ready",
              service: "web",
              dependencies: { postgresql: ready ? "up" : "down" },
            }),
            () => ({
              status: "not_ready",
              service: "web",
              dependencies: { postgresql: "down" },
            }),
          );
    const status = body.status === "not_ready" ? 503 : 200;
    if (request.method === "HEAD") return new Response(null, { status, headers });
    return Response.json(body, { status, headers });
  };
}
