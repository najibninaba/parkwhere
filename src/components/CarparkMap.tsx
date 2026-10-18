import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import type { NearbyCarpark } from "../../shared/domain";
import { spaceLevel } from "../format";
import type { Destination } from "./SearchBox";

// OneMap basemap. OneMap requires its logo and this attribution on every map that uses its tiles:
// https://www.onemap.gov.sg/docs/maps/
const ONEMAP_TILES = "https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png";
const ONEMAP_ATTRIBUTION =
  '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" style="height:20px;width:20px;vertical-align:middle" alt=""/>&nbsp;' +
  '<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a>&nbsp;&copy;&nbsp;contributors&nbsp;&#124;&nbsp;' +
  '<a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>';
const SG_BOUNDS = L.latLngBounds([1.144, 103.535], [1.494, 104.1]);

interface Props {
  destination: Destination;
  carparks: NearbyCarpark[];
  radiusM: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const markerIcon = (rank: number, carpark: NearbyCarpark, selected: boolean) =>
  L.divIcon({
    className: "",
    html: `<span class="pin pin-${spaceLevel(carpark.car, Date.now())}${selected ? " pin-selected" : ""}">${rank}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });

export default function CarparkMap({ destination, carparks, radiusM, selectedId, onSelect }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!element.current || map.current) return;
    map.current = L.map(element.current, { minZoom: 11, maxZoom: 19, maxBounds: SG_BOUNDS, zoomControl: true, attributionControl: true });
    map.current.attributionControl.setPrefix(false);
    L.tileLayer(ONEMAP_TILES, { detectRetina: true, minZoom: 11, maxZoom: 19, attribution: ONEMAP_ATTRIBUTION }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  const markers = useRef(new Map<string, L.Marker>());
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  // Redraw and refit only when the destination, radius or set of carparks changes, so a reader's
  // own pan and zoom survive the periodic refresh and re-sorting.
  const layoutKey = `${destination.lat},${destination.lng},${radiusM}|${carparks.map((carpark) => carpark.id).sort().join(",")}`;
  useEffect(() => {
    const current = map.current;
    const group = layer.current;
    if (!current || !group) return;
    group.clearLayers();
    markers.current.clear();
    L.circle([destination.lat, destination.lng], { radius: radiusM, color: "#151412", weight: 1, dashArray: "4 4", fillOpacity: 0.04 }).addTo(group);
    L.marker([destination.lat, destination.lng], {
      icon: L.divIcon({ className: "", html: '<span class="pin-destination" aria-hidden="true"></span>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      title: destination.name,
      keyboard: false
    }).addTo(group);
    for (const carpark of carparks) {
      const marker = L.marker([carpark.lat, carpark.lng], { title: carpark.address, riseOnHover: true })
        .on("click", () => selectRef.current(carpark.id))
        .addTo(group);
      markers.current.set(carpark.id, marker);
    }
    const bounds = L.latLngBounds([[destination.lat, destination.lng], ...carparks.map((carpark) => [carpark.lat, carpark.lng] as [number, number])]);
    current.fitBounds(bounds.pad(0.15), { maxZoom: 17, animate: false });
  }, [layoutKey]);

  // Ranks, colours and selection change in place.
  useEffect(() => {
    carparks.forEach((carpark, index) => {
      const marker = markers.current.get(carpark.id);
      if (!marker) return;
      marker.setIcon(markerIcon(index + 1, carpark, carpark.id === selectedId));
      marker.setZIndexOffset(carpark.id === selectedId ? 1000 : 0);
    });
  }, [layoutKey, carparks, selectedId]);

  return <div ref={element} className="map" role="region" aria-label="Map of nearby carparks" />;
}
