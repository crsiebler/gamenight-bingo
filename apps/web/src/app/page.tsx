import type { Metadata } from "next";

import { patternCatalog } from "@gamenight-bingo/patterns";

import { PublicLandingPage } from "@/templates";

export const metadata: Metadata = {
  title: "GameNight Bingo | Create a private bingo lobby",
  description:
    "Create a private 75-ball bingo lobby for friends and family with your choice of theme, pattern, and call pace.",
};

const patternOptions = patternCatalog.map(({ category, id, name }) => ({ category, id, name }));

export default function HomePage() {
  return <PublicLandingPage patterns={patternOptions} />;
}
