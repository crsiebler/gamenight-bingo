import { Client } from "pg";

const databaseUrl = process.env["TEST_DATABASE_URL"];
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("TEST_DATABASE_URL is required for the browser database preflight.");
}
if (process.env["E2E_DATABASE_CONFIRMED_NONPRODUCTION"] !== "true") {
  throw new Error(
    "E2E_DATABASE_CONFIRMED_NONPRODUCTION=true is required for the browser database preflight.",
  );
}

const client = new Client({ connectionString: databaseUrl });
try {
  await client.connect();
  const result = await client.query<{ has_lobby: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM lobbies LIMIT 1) AS has_lobby",
  );
  if (result.rows[0]?.has_lobby !== false) {
    throw new Error("The Playwright database must be fresh and contain no lobbies.");
  }
} finally {
  await client.end();
}
