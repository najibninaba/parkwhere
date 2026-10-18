import { useEffect, useId, useRef, useState } from "react";
import type { Place } from "../../shared/domain";
import type { LookupVia } from "../../shared/usage";
import { ApiError, searchPlaces } from "../api";

export interface Destination {
  name: string;
  lat: number;
  lng: number;
  /** How it was chosen, for the anonymous lookup count. */
  via?: LookupVia;
}

interface Props {
  destination: Destination | null;
  onChoose: (destination: Destination) => void;
  /** The landing page's main call to action: larger field and button. */
  prominent?: boolean;
}

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "results"; query: string; places: Place[]; source: string } | { kind: "error"; message: string };

export function SearchBox({ destination, onChoose, prominent = false }: Props) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setStatus({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setStatus({ kind: "loading" });
      searchPlaces(trimmed, controller.signal)
        .then((response) => setStatus({ kind: "results", query: trimmed, places: response.results, source: response.source }))
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setStatus({ kind: "error", message: error instanceof ApiError ? error.message : "Search failed." });
        });
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  const choose = (place: Destination) => {
    onChoose(place);
    setQuery("");
    setStatus({ kind: "idle" });
    inputRef.current?.blur();
  };

  const useMyLocation = () => {
    if (!("geolocation" in navigator)) {
      setLocationError("This browser can't share your location.");
      return;
    }
    setLocating(true);
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        choose({ name: "your location", lat: position.coords.latitude, lng: position.coords.longitude, via: "near-me" });
      },
      () => {
        setLocating(false);
        setLocationError("Couldn't get your location. Search for a place instead.");
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 }
    );
  };

  const open = status.kind !== "idle";

  return (
    <div className={`search${prominent ? " search-prominent" : ""}`}>
      <label className={prominent ? "label" : "sr-only"} htmlFor={`${listId}-input`}>
        Where are you going?
      </label>
      <div className="search-row">
        <input
          ref={inputRef}
          id={`${listId}-input`}
          className="search-input"
          type="search"
          inputMode="search"
          autoComplete="off"
          placeholder={destination ? "Search another place" : "Place or postal code"}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            // Results for the previous text must not be chosen while the new search is pending.
            setStatus((current) => (current.kind === "results" && current.query !== event.target.value.trim() ? { kind: "loading" } : current));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && status.kind === "results" && status.query === query.trim() && status.places[0]) choose({ ...status.places[0], via: "search" });
            if (event.key === "Escape") setQuery("");
          }}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
        />
        <button type="button" className="button button-locate" onClick={useMyLocation} disabled={locating}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          </svg>
          {locating ? "Locating…" : "Near me"}
        </button>
      </div>
      {locationError && <p className="hint hint-bad">{locationError}</p>}
      {open && (
        <div className="search-results" id={listId} role="listbox" aria-label="Places">
          {status.kind === "loading" && <p className="hint">Searching…</p>}
          {status.kind === "error" && <p className="hint hint-bad">{status.message}</p>}
          {status.kind === "results" && status.source === "hdb-registry" && (
            <p className="hint">Place search is unavailable. Search by HDB carpark address.</p>
          )}
          {status.kind === "results" && status.places.length === 0 && <p className="hint">No matches. Try a block number, road or postal code.</p>}
          {status.kind === "results" &&
            status.places.map((place) => (
              <button
                type="button"
                role="option"
                aria-selected={false}
                key={`${place.name}-${place.lat}-${place.lng}`}
                className="search-option"
                onClick={() => choose({ name: place.name, lat: place.lat, lng: place.lng, via: "search" })}
              >
                <span className="search-option-name">{place.name}</span>
                <span className="search-option-address">
                  {place.address}
                  {place.postal ? ` · ${place.postal}` : ""}
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
