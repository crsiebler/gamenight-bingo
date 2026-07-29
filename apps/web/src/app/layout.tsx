import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  applicationName: "GameNight Bingo",
  metadataBase: new URL("https://gamenight.bingo"),
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#102a43",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
