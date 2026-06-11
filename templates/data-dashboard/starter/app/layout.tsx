import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Data Dashboard",
  description: "A full-screen ECharts data dashboard starter.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
