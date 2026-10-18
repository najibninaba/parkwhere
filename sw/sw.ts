/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { addPlugins, cleanupOutdatedCaches, PrecacheFallbackPlugin, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { NetworkOnly } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// A new version takes over straight away; src/main.tsx reloads the page onto it.
self.skipWaiting();
clientsClaim();

// The Worker answers a missing file with the app page (single-page fallback), as a 200. Precaching that
// under a script's name would leave a blank page for the life of this version, so refuse it: the install
// fails and the previous version stays.
addPlugins([
  {
    cacheWillUpdate: async ({ request, response }) => {
      if (!response || response.status >= 400) return null;
      const isPage = /(^|\/)[^/.]*$|\.html$/.test(new URL(request.url).pathname);
      const isHtml = response.headers.get("content-type")?.startsWith("text/html") ?? false;
      return isHtml && !isPage ? null : response;
    }
  }
]);

// directoryIndex is set to a name that never exists, so "/" doesn't match the precached index.html and
// get served cache-first.
precacheAndRoute(self.__WB_MANIFEST, { directoryIndex: "__network-only__" });
cleanupOutdatedCaches();

// Pages always come from the network, so a deploy shows up on the next visit. When the network fails or
// takes over 4 seconds, the app shell precached by this same version is served, so the page and its
// JS/CSS always match. Pages are never cached separately: an old page could outlive its bundles.
// Nothing else is routed, so the API and /health always go to the network.
registerRoute(
  ({ request }) => request.mode === "navigate",
  new NetworkOnly({ networkTimeoutSeconds: 4, plugins: [new PrecacheFallbackPlugin({ fallbackURL: "index.html" })] })
);
