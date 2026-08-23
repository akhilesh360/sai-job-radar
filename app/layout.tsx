import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sai Job Radar",
  description: "A private command center for discovering and tracking US data, AI, GTM, and engineering jobs.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "Sai Job Radar",
    description: "US data jobs. One focused feed.",
    images: [{ url: "/favicon.svg" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Sai Job Radar",
    description: "US data jobs. One focused feed.",
    images: ["/favicon.svg"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
