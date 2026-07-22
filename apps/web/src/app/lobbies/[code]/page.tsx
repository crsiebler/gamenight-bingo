import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LobbyCodeSchema, parseRuntimeConfig } from "@gamenight-bingo/contracts";
import { normalizeLobbyCodeEntry } from "@gamenight-bingo/domain";
import { patternCatalog } from "@gamenight-bingo/patterns";

import { PrivateLobbyPage } from "@/templates";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Private lobby | GameNight Bingo",
  description: "Private GameNight Bingo lobby.",
  robots: "noindex, nofollow, noarchive",
};

type LobbyPageProps = {
  params: Promise<{ code: string }>;
};

const patterns = patternCatalog.map(({ category, id, name }) => ({ category, id, name }));

export default async function LobbyPage({ params }: LobbyPageProps) {
  const code = normalizeLobbyCodeEntry((await params).code);
  if (!LobbyCodeSchema.safeParse(code).success) notFound();
  const realtimeServerUrl = parseRuntimeConfig(process.env).publicGameServerUrl;
  return (
    <PrivateLobbyPage
      code={code}
      enableRealtime
      patterns={patterns}
      {...(realtimeServerUrl === undefined ? {} : { realtimeServerUrl })}
    />
  );
}
