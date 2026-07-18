import { env } from "node:process";

import { RuntimeConfigurationError } from "@gamenight-bingo/contracts";

import { GameServerConfigurationError, startGameServerRuntime } from "./runtime.js";

export const gameServer = await startGameServerRuntime(env).catch((error: unknown) => {
  if (error instanceof RuntimeConfigurationError || error instanceof GameServerConfigurationError) {
    throw error;
  }
  throw new Error("The game server failed to start.");
});

let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void gameServer.close().catch(() => {});
};
process.once("SIGINT", close);
process.once("SIGTERM", close);

await gameServer.completion.catch(() => {
  throw new Error("The game server runtime failed.");
});
