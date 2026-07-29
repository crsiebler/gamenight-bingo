import { createWebHealthHandler } from "../../health";

export const runtime = "nodejs";

const handle = createWebHealthHandler(async () => false);

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
