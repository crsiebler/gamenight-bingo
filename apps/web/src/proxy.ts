import { type NextRequest, NextResponse } from "next/server";

import { createContentSecurityPolicy } from "./http-security.js";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(globalThis.crypto.randomUUID(), "ascii").toString("base64");
  const contentSecurityPolicy = createContentSecurityPolicy({
    nonce,
    development: process.env["NODE_ENV"] === "development",
    webOrigin: process.env["WEB_ORIGIN"] ?? "http://localhost:3000",
    ...(process.env["NEXT_PUBLIC_GAME_SERVER_URL"] === undefined
      ? {}
      : { gameServerUrl: process.env["NEXT_PUBLIC_GAME_SERVER_URL"] }),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", contentSecurityPolicy);
  requestHeaders.set("x-nonce", nonce);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  if (request.nextUrl.pathname.startsWith("/lobbies/")) {
    response.headers.set(
      "Cache-Control",
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  }
  return response;
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico|icon).*)",
};
