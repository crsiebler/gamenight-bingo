import { env } from "node:process";

import { RuntimeConfigurationError } from "@gamenight-bingo/contracts";
import { createOperationalLogger } from "@gamenight-bingo/database";

import { GameServerConfigurationError, startGameServerRuntime } from "./runtime.js";

const operationalLogger = createOperationalLogger({ service: "game-server" });

export const gameServer = await startGameServerRuntime(env, undefined, operationalLogger).catch(
  (error: unknown) => {
    if (
      error instanceof RuntimeConfigurationError ||
      error instanceof GameServerConfigurationError
    ) {
      throw error;
    }
    throw new Error("The game server failed to start.");
  },
);

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
