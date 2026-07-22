import type { Metadata } from "next";

import { LobbyCodeSchema, parseRuntimeConfig } from "@gamenight-bingo/contracts";
import { normalizeLobbyCodeEntry } from "@gamenight-bingo/domain";
import { patternCatalog } from "@gamenight-bingo/patterns";

import { PublicLandingPage } from "@/templates";

export const metadata: Metadata = {
  title: "GameNight Bingo | Create a private bingo lobby",
  description:
    "Create a private 75-ball bingo lobby for friends and family with your choice of theme, pattern, and call pace.",
};

const patternOptions = patternCatalog.map(({ category, id, name }) => ({ category, id, name }));

type HomePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function HomePage({ searchParams = Promise.resolve({}) }: HomePageProps) {
  const codeParameter = (await searchParams)["code"];
  const normalizedCode =
    typeof codeParameter === "string" ? normalizeLobbyCodeEntry(codeParameter) : "";
  const initialLobbyCode = LobbyCodeSchema.safeParse(normalizedCode).success ? normalizedCode : "";
  const { lobbyIdleTtlSeconds, playerReconnectWindowSeconds } = parseRuntimeConfig(process.env);

  return (
    <PublicLandingPage
      initialLobbyCode={initialLobbyCode}
      lobbyIdleTtlSeconds={lobbyIdleTtlSeconds}
      patterns={patternOptions}
      playerReconnectWindowSeconds={playerReconnectWindowSeconds}
    />
  );
}
