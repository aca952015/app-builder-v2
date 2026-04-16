import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Generated Mini App",
  description: "A lightweight starter scaffold for the mini-app template.",
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
