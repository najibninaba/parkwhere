import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    cloudflare(),
    VitePWA({
      // The app registers the service worker itself (src/main.tsx) so it can reload onto a new version.
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["favicon.svg", "icons/favicon-32.png", "icons/apple-touch-icon-180.png"],
      manifest: {
        name: "ParkWhere: Singapore parking",
        short_name: "ParkWhere",
        description: "Find a carpark near where you're going in Singapore, with available car lots and price estimates.",
        theme_color: "#151412",
        background_color: "#f5f0e5",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }
        ]
      },
      workbox: {
        // Pages come from the network first, so a deploy shows up on the next visit. The cached copy is
        // only for offline use. (Serving the page from the precache first kept old versions on screen.)
        navigateFallback: null,
        // HTML stays out of the precache: Workbox's precache route runs before runtime routes, so a
        // precached index.html would still be served cache-first.
        globPatterns: ["**/*.{js,css,svg,png,webmanifest}"],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          // Availability must never come from the service worker cache. urlPattern regexes match the full
          // URL, so pathname checks are used.
          { urlPattern: ({ url }) => url.pathname.startsWith("/api/") || url.pathname === "/health", handler: "NetworkOnly" },
          {
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: { cacheName: "pages", networkTimeoutSeconds: 4, expiration: { maxEntries: 8 } }
          }
        ]
      }
    })
  ]
});
