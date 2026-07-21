export const MUTATION_REQUEST_HEADERS = Object.freeze({
  "content-type": "application/json",
  "x-gamenight-request": "mutation",
});

export const COMMON_SECURITY_RESPONSE_HEADERS = Object.freeze([
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=()" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
] as const);

export const PRIVATE_RESPONSE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow, noarchive",
});

function parseHttpOrigin(value: string, environmentKey: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error(`${environmentKey} must be a valid HTTP or HTTPS origin.`);
  }
  if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.origin !== value) {
    throw new Error(`${environmentKey} must be a valid HTTP or HTTPS origin.`);
  }
  return origin;
}

function websocketOrigin(origin: URL): string {
  return `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}`;
}

export function createContentSecurityPolicy(input: {
  readonly nonce: string;
  readonly webOrigin: string;
  readonly gameServerUrl?: string;
  readonly development: boolean;
}): string {
  const webOrigin = parseHttpOrigin(input.webOrigin, "WEB_ORIGIN");
  const connectSources = new Set(["'self'", websocketOrigin(webOrigin)]);
  if (input.gameServerUrl !== undefined) {
    const gameServerUrl = parseHttpOrigin(input.gameServerUrl, "NEXT_PUBLIC_GAME_SERVER_URL");
    connectSources.add(gameServerUrl.origin);
    connectSources.add(websocketOrigin(gameServerUrl));
  }

  const developmentScriptSource = input.development ? " 'unsafe-eval'" : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${input.nonce}' 'strict-dynamic'${developmentScriptSource}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${[...connectSources].join(" ")}`,
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
