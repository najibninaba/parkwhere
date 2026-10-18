import { useEffect, useId, useRef, useState } from "react";
import type { Place } from "../../shared/domain";
import { ApiError, searchPlaces } from "../api";

export interface Destination {
  name: string;
  lat: number;
  lng: number;
}

interface Props {
  destination: Destination | null;
  onChoose: (destination: Destination) => void;
}

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "results"; query: string; places: Place[]; source: string } | { kind: "error"; message: string };

export function SearchBox({ destination, onChoose }: Props) {
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
        choose({ name: "Your location", lat: position.coords.latitude, lng: position.coords.longitude });
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
    <div className="search">
      <label className="label" htmlFor={`${listId}-input`}>
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
          placeholder={destination ? destination.name : "Place, building, postal code"}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            // Results for the previous text must not be chosen while the new search is pending.
            setStatus((current) => (current.kind === "results" && current.query !== event.target.value.trim() ? { kind: "loading" } : current));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && status.kind === "results" && status.query === query.trim() && status.places[0]) choose(status.places[0]);
            if (event.key === "Escape") setQuery("");
          }}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
        />
        <button type="button" className="button" onClick={useMyLocation} disabled={locating}>
          {locating ? "Locating…" : "Near me"}
        </button>
      </div>
      {locationError && <p className="hint hint-bad">{locationError}</p>}
      {open && (
        <div className="search-results" id={listId} role="listbox" aria-label="Places">
          {status.kind === "loading" && <p className="hint">Searching…</p>}
          {status.kind === "error" && <p className="hint hint-bad">{status.message}</p>}
          {status.kind === "results" && status.source === "hdb-registry" && (
            <p className="hint">Place search isn't set up yet, so this only matches HDB carpark addresses.</p>
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
                onClick={() => choose({ name: place.name, lat: place.lat, lng: place.lng })}
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
