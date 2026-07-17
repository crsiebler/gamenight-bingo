import { env } from "node:process";

import { parseRuntimeConfig } from "@gamenight-bingo/contracts";

export const runtimeConfig = parseRuntimeConfig(env);
