import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DM Setter Agent",
  description: "Qualified Instagram DM appointment setting with permanent lead memory.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
