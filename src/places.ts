import type { Destination } from "./components/SearchBox";

/**
 * Quick picks for the landing page: busy places with many HDB carparks around them.
 * Coordinates from OneMap search, checked 2026-10-18.
 */
export const QUICK_PICKS: (Destination & { label: string })[] = [
  { label: "Bugis", name: "Bugis Junction", lat: 1.29911, lng: 103.85541 },
  { label: "Chinatown", name: "People's Park Complex", lat: 1.28413, lng: 103.84252 },
  { label: "Toa Payoh", name: "HDB Hub, Toa Payoh", lat: 1.33205, lng: 103.84851 },
  { label: "Ang Mo Kio", name: "AMK Hub", lat: 1.36939, lng: 103.84848 },
  { label: "Tampines", name: "Our Tampines Hub", lat: 1.35313, lng: 103.94041 },
  { label: "Jurong East", name: "JEM, Jurong East", lat: 1.33329, lng: 103.74328 }
];
