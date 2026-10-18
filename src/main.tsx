import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import { registerSW } from "virtual:pwa-register";

// Reloads once when a new version's service worker takes over, and checks for one hourly so a tab
// left open picks up deploys too.
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (registration) window.setInterval(() => void registration.update(), 60 * 60_000);
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
