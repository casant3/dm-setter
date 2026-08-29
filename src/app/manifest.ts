import type { MetadataRoute } from "next";

/**
 * Web app manifest.
 *
 * Installing is optional — the site works exactly the same in a normal browser
 * tab — but a home-screen icon and standalone display remove the browser
 * chrome, which is worth a surprising amount when the loop is
 * Instagram → here → Instagram all day.
 *
 * Deliberately contains nothing sensitive: no handles, no account names, no
 * credentials. A manifest is a public document.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "DM Setter Agent",
    short_name: "DM Setter",
    description: "Qualified Instagram DM appointment setting with permanent lead memory.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0e1116",
    theme_color: "#0e1116",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
