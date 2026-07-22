import { handleWebHealthRequest } from "../../lobby-entry-runtime";

export const runtime = "nodejs";

export const GET = handleWebHealthRequest;
export const HEAD = handleWebHealthRequest;
export const POST = handleWebHealthRequest;
export const PUT = handleWebHealthRequest;
export const PATCH = handleWebHealthRequest;
export const DELETE = handleWebHealthRequest;
export const OPTIONS = handleWebHealthRequest;
