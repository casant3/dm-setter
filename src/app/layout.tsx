import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DM Setter Agent",
  description: "Qualified Instagram DM appointment setting with permanent lead memory.",
  applicationName: "DM Setter",
  appleWebApp: {
    // Standalone on iOS too, so an installed icon behaves like the Android one.
    capable: true,
    title: "DM Setter",
    statusBarStyle: "black-translucent",
  },
  // Prospect data is behind a password; it has no business in a search index.
  robots: { index: false, follow: false },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Zoom stays available: pinch-to-zoom is an accessibility feature, and the
  // layout does not depend on it being off.
  maximumScale: 5,
  themeColor: "#0e1116",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
