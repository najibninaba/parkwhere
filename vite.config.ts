import { execFileSync } from "node:child_process";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite";

/** "2026-10-20.47bacd5": the build date (UTC) and commit, stored with feedback so a report can be tied to a build. */
function appVersion(): string {
  const date = new Date().toISOString().slice(0, 10);
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[0-9a-f]{4,40}$/.test(sha) ? `${date}.${sha}` : date;
  } catch {
    return date;
  }
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  plugins: [
    react(),
    cloudflare(),
    VitePWA({
      // The app registers the service worker itself (src/main.tsx) so it can reload onto a new version.
      registerType: "autoUpdate",
      injectRegister: false,
      // The service worker is hand-written (sw/sw.ts): its page timeout and precache check aren't
      // available through the generated one.
      strategies: "injectManifest",
      srcDir: "sw",
      filename: "sw.ts",
      injectManifest: { globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"] },
      includeAssets: ["favicon.svg", "icons/favicon-32.png", "icons/apple-touch-icon-180.png"],
      manifest: {
        name: "ParkWhere: Singapore parking",
        short_name: "ParkWhere",
        description: "Singapore parking finder: nearby carparks, available car lots and estimated parking costs.",
        theme_color: "#151412",
        background_color: "#f5f0e5",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }
        ]
      }
    })
  ]
});
