// Hand-off to established navigation apps. The destination is the carpark's registry point,
// which is not necessarily its entrance.

export type NavApp = "google" | "apple" | "waze";

export const NAV_APPS: { id: NavApp; label: string }[] = [
  { id: "google", label: "Google Maps" },
  { id: "apple", label: "Apple Maps" },
  { id: "waze", label: "Waze" }
];

export function navigationUrl(app: NavApp, point: { lat: number; lng: number }): string {
  const ll = `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
  switch (app) {
    case "google":
      return `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`;
    case "apple":
      return `https://maps.apple.com/?daddr=${ll}&dirflg=d`;
    case "waze":
      return `https://waze.com/ul?ll=${ll}&navigate=yes`;
  }
}
