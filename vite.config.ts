import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    cloudflare(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "script",
      includeAssets: ["favicon.svg", "icons/favicon-32.png", "icons/apple-touch-icon-180.png"],
      manifest: {
        name: "ParkWhere — Singapore HDB parking",
        short_name: "ParkWhere",
        description: "Find an HDB carpark near where you're going, with live spaces and honest prices.",
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
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/health/],
        // Availability must never come from the service worker cache. urlPattern regexes match the full URL,
        // so a pathname check is used.
        runtimeCaching: [{ urlPattern: ({ url }) => url.pathname.startsWith("/api/") || url.pathname === "/health", handler: "NetworkOnly" }]
      }
    })
  ]
});
