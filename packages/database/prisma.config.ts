import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "prisma/config";

const packageDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  schema: join(packageDirectory, "prisma/schema.prisma"),
  migrations: {
    path: join(packageDirectory, "prisma/migrations"),
  },
  datasource: {
    url:
      process.env["DATABASE_URL"] ??
      "postgresql://invalid:invalid@127.0.0.1:1/database-url-required",
  },
});
