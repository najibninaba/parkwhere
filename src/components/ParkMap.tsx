import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import type { NearbyCarpark, OverviewResponse } from "../../shared/domain";
import { LEVEL_CODES } from "../../shared/levels";
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
const SG_VIEW = L.latLngBounds([1.24, 103.62], [1.47, 104.0]);

/** Dot colours per level, matching the --plenty … --unknown tokens in index.css. */
const LEVEL_COLOURS: Record<string, string> = { plenty: "#1a9e57", some: "#6a9e1a", few: "#d98a1c", full: "#c2412d", unknown: "#8c877c" };

interface Props {
  overview: OverviewResponse["points"] | null;
  /** False once the overview is out of date: dots turn grey instead of claiming current spaces. */
  overviewCurrent: boolean;
  destination: Destination | null;
  carparks: NearbyCarpark[];
  radiusM: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSearchArea: (center: { lat: number; lng: number }) => void;
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** On wide screens the panel floats over the left of the map, so fitted views keep clear of it. */
const fitPadding = (): L.FitBoundsOptions =>
  window.innerWidth >= 900 ? { paddingTopLeft: [472, 24], paddingBottomRight: [24, 24] } : { paddingTopLeft: [16, 16], paddingBottomRight: [16, 40] };

/** Dot size grows with zoom, so the island view isn't a blur and street views stay readable. */
const dotRadius = (zoom: number, faded: boolean) => (faded ? 2.5 : zoom <= 11 ? 2.4 : zoom <= 13 ? 3.2 : 4.5);

const markerIcon = (rank: number, carpark: NearbyCarpark, selected: boolean) =>
  L.divIcon({
    className: "",
    html: `<span class="pin pin-${spaceLevel(carpark.car, Date.now())}${selected ? " pin-selected" : ""}">${rank}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });

export default function ParkMap({ overview, overviewCurrent, destination, carparks, radiusM, selectedId, onSelect, onSearchArea }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const dots = useRef<L.LayerGroup | null>(null);
  const results = useRef<L.LayerGroup | null>(null);
  const markers = useRef(new Map<string, L.Marker>());
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const [tilesReady, setTilesReady] = useState(false);
  const [moved, setMoved] = useState(false);
  const [zoom, setZoom] = useState(11);
  // Set while the map moves itself, so only a reader's own pan or zoom (mouse, touch or keyboard) offers "Search this area".
  const programmatic = useRef(false);

  useEffect(() => {
    if (!element.current || map.current) return;
    const instance = L.map(element.current, { minZoom: 11, maxZoom: 19, maxBounds: SG_BOUNDS, zoomControl: false, attributionControl: true, preferCanvas: true });
    L.control.zoom({ position: "bottomright" }).addTo(instance);
    instance.attributionControl.setPrefix(false);
    programmatic.current = true;
    instance.fitBounds(SG_VIEW, { animate: false, ...fitPadding() });
    const tiles = L.tileLayer(ONEMAP_TILES, { detectRetina: true, minZoom: 11, maxZoom: 19, attribution: ONEMAP_ATTRIBUTION });
    tiles.once("load", () => setTilesReady(true));
    tiles.addTo(instance);
    dots.current = L.layerGroup().addTo(instance);
    results.current = L.layerGroup().addTo(instance);
    instance.on("movestart", () => {
      if (!programmatic.current) setMoved(true);
    });
    instance.on("moveend", () => {
      programmatic.current = false;
    });
    instance.on("zoomend", () => setZoom(instance.getZoom()));
    // The pane changes height between landing and results; Leaflet must re-measure before fitting.
    const resize = new ResizeObserver(() => instance.invalidateSize({ pan: false }));
    resize.observe(element.current);
    map.current = instance;
    return () => {
      resize.disconnect();
      instance.remove();
      map.current = null;
    };
  }, []);

  // Every carpark as a dot, built once per overview payload and restyled in place on zoom, fade and
  // expiry, so ~2,100 layers aren't recreated each time.
  const dotLayers = useRef<{ marker: L.CircleMarker; code: number }[]>([]);
  useEffect(() => {
    const group = dots.current;
    if (!group) return;
    group.clearLayers();
    dotLayers.current = (overview ?? []).map(([lat, lng, code]) => ({
      marker: L.circleMarker([lat, lng], { stroke: false, interactive: false }).addTo(group),
      code
    }));
  }, [overview]);
  useEffect(() => {
    const faded = destination !== null;
    const radius = dotRadius(zoom, faded);
    for (const { marker, code } of dotLayers.current) {
      const level = overviewCurrent ? (LEVEL_CODES[code] ?? "unknown") : "unknown";
      marker.setRadius(radius);
      marker.setStyle({ fillColor: LEVEL_COLOURS[level], fillOpacity: faded ? 0.35 : 0.9 });
    }
  }, [overview, overviewCurrent, destination, zoom]);

  // Numbered results, redrawn and refitted only when the destination, radius or set of carparks changes,
  // so a reader's own pan and zoom survive the periodic refresh and re-sorting.
  const layoutKey = destination ? `${destination.lat},${destination.lng},${radiusM}|${carparks.map((carpark) => carpark.id).sort().join(",")}` : "none";
  useEffect(() => {
    const current = map.current;
    const group = results.current;
    if (!current || !group) return;
    group.clearLayers();
    markers.current.clear();
    setMoved(false);
    current.invalidateSize({ pan: false });
    const animate = !reducedMotion();
    programmatic.current = true;
    // A fit that doesn't move the map fires no moveend; don't let the flag outlive the animation.
    const settle = window.setTimeout(() => {
      programmatic.current = false;
    }, 1200);
    if (!destination) {
      current.flyToBounds(SG_VIEW, { animate, duration: 0.8, ...fitPadding() });
      return () => window.clearTimeout(settle);
    }
    L.circle([destination.lat, destination.lng], { radius: radiusM, color: "#151412", weight: 1, dashArray: "4 4", fillOpacity: 0.04, interactive: false }).addTo(group);
    L.marker([destination.lat, destination.lng], {
      icon: L.divIcon({ className: "", html: '<span class="pin-destination" aria-hidden="true"></span>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      title: destination.name,
      keyboard: false
    }).addTo(group);
    for (const carpark of carparks) {
      // The cards are the keyboard and screen-reader path; pins stay out of the tab order.
      const marker = L.marker([carpark.lat, carpark.lng], { title: carpark.address, riseOnHover: true, keyboard: false })
        .on("click", () => selectRef.current(carpark.id))
        .addTo(group);
      markers.current.set(carpark.id, marker);
    }
    const bounds = L.latLngBounds([[destination.lat, destination.lng], ...carparks.map((carpark) => [carpark.lat, carpark.lng] as [number, number])]);
    current.flyToBounds(bounds.pad(0.1), { maxZoom: 17, animate, duration: 0.8, ...fitPadding() });
    return () => window.clearTimeout(settle);
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

  const searchHere = () => {
    const center = map.current?.getCenter();
    if (!center) return;
    setMoved(false);
    onSearchArea({ lat: center.lat, lng: center.lng });
  };

  return (
    <div className={`map-frame${tilesReady ? " map-ready" : ""}`}>
      <div ref={element} className="map" role="region" aria-label={destination ? "Map of nearby carparks" : "Map of carparks across Singapore"} />
      {!tilesReady && (
        <div className="map-skeleton" aria-hidden="true">
          <span>Loading map…</span>
        </div>
      )}
      {moved && (
        <button type="button" className="button map-search-here" onClick={searchHere}>
          Search this area
        </button>
      )}
    </div>
  );
}
