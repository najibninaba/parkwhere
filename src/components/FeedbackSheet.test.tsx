import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NearbyCarpark } from "../../shared/domain";
import { FeedbackSheet, type FeedbackTarget } from "./FeedbackSheet";

const carpark = (overrides: Partial<NearbyCarpark> = {}): NearbyCarpark => ({
  id: "ACB",
  address: "BLK 270/271 ALBERT CENTRE BASEMENT CAR PARK",
  lat: 1.30106,
  lng: 103.85412,
  carparkType: "BASEMENT CAR PARK",
  parkingSystem: "ELECTRONIC PARKING",
  shortTermParking: "WHOLE DAY",
  freeParking: "NO",
  nightParking: true,
  gantryHeightM: 2.1,
  basement: true,
  distanceM: 150,
  car: { reportedBy: "HDB", state: "known", available: 41, total: 143, recordedAt: "2026-10-20T02:02:00Z", freshness: "current" },
  ...overrides
});
const osm = carpark({ source: "osm", id: "osm:place:way/1", address: "Carpark mapped at Jewel Changi Airport", lat: 1.36041, lng: 103.98983 });
const lta = carpark({ source: "lta", id: "lta:1", address: "Suntec City" });

/** Opens the sheet from a real button, as the app does, so focus can be checked going back to it. */
function Harness({ target }: { target: FeedbackTarget }) {
  const [open, setOpen] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button type="button" onClick={(event) => setOpen(event.currentTarget)}>
        Open
      </button>
      {open && <FeedbackSheet target={{ ...target, returnFocus: open }} onClose={() => setOpen(null)} />}
    </>
  );
}

const respond = (...responses: (Response | Error)[]) => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};
const sentBody = (fetcher: ReturnType<typeof respond>, call = 0) => JSON.parse(String(fetcher.mock.calls[call][1]?.body));

async function open(target: FeedbackTarget) {
  const user = userEvent.setup();
  render(<Harness target={target} />);
  await user.click(screen.getByRole("button", { name: "Open" }));
  return { user, dialog: screen.getByRole("dialog") };
}

afterEach(() => vi.unstubAllGlobals());

describe("FeedbackSheet", () => {
  it("offers the reasons that fit each source", async () => {
    const reasons = () => within(screen.getByRole("group", { name: "What's wrong?" })).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent);
    const first = render(<FeedbackSheet target={{ kind: "carpark", carpark: carpark(), shown: "x" }} onClose={() => undefined} />);
    expect(reasons()).toEqual([
      "The location or entrance is wrong",
      "It's closed or gone",
      "Only residents, staff or season holders can park",
      "The count looks wrong",
      "The rates look wrong",
      "Something else"
    ]);
    first.unmount();
    const second = render(<FeedbackSheet target={{ kind: "carpark", carpark: lta, shown: "x" }} onClose={() => undefined} />);
    expect(reasons()).not.toContain("The rates look wrong");
    expect(reasons()).toContain("The count looks wrong");
    second.unmount();
    render(<FeedbackSheet target={{ kind: "carpark", carpark: osm, shown: "No live count" }} onClose={() => undefined} />);
    expect(reasons()).toEqual(["The location or entrance is wrong", "It's closed or gone", "Only residents, staff or season holders can park", "It isn't a carpark", "Something else"]);
  });

  it("names the carpark, focuses the first reason, closes on Esc and returns focus to what opened it", async () => {
    respond(new Response(null, { status: 204 }));
    const { user, dialog } = await open({ kind: "carpark", carpark: carpark(), shown: "x" });
    expect(dialog).toHaveAttribute("open");
    expect(within(dialog).getByText("Blk 270/271 Albert Centre Basement Car Park (ACB)")).toBeInTheDocument();
    expect(within(dialog).getByText("HDB carpark · count from data.gov.sg")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "The location or entrance is wrong" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
  });

  it("asks for a reason, and for a note on Something else, before sending", async () => {
    const fetcher = respond(new Response(null, { status: 204 }));
    const { user, dialog } = await open({ kind: "carpark", carpark: carpark(), shown: "x" });
    const send = within(dialog).getByRole("button", { name: "Send report" });
    await user.click(send);
    expect(within(dialog).getByText("Choose what's wrong.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("radio", { name: "Something else" }));
    expect(within(dialog).getByLabelText("What did you see? (required)")).toBeInTheDocument();
    await user.click(send);
    expect(within(dialog).getByText("Add a note to say what's wrong.")).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox")).toHaveFocus();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("says Sent only after a 2xx, and sends what the card showed for a count report", async () => {
    let release: (response: Response) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const { user, dialog } = await open({ kind: "carpark", carpark: carpark(), shown: "41 car lots available out of 143, reported 20 Oct 10:02" });
    await user.click(within(dialog).getByRole("radio", { name: "The count looks wrong" }));
    expect(within(dialog).getByText("Your report includes what the card showed: 41 car lots available out of 143, reported 20 Oct 10:02.")).toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox"), "Says 41 but the gantry sign says full");
    expect(within(dialog).getByText("37/500")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));
    // A second tap while sending sends nothing more.
    await user.click(within(dialog).getByRole("button", { name: "Sending…" }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(within(dialog).queryByText(/Thanks/)).not.toBeInTheDocument();
    release(new Response(null, { status: 204 }));
    expect(await within(dialog).findByText("Thanks. Your report was sent to ParkWhere.")).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Report sent" })).toHaveFocus();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/feedback");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "carpark",
      reason: "count",
      carparkId: "ACB",
      source: "hdb",
      shown: "41 car lots available out of 143, reported 20 Oct 10:02",
      note: "Says 41 but the gantry sign says full",
      website: "",
      appVersion: "test"
    });
    // HDB cards get no OpenStreetMap link.
    expect(within(dialog).queryByRole("link", { name: /OpenStreetMap/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the note and says so when sending fails, then sends on retry", async () => {
    const fetcher = respond(new TypeError("Failed to fetch"), Response.json({ error: "Feedback isn't available right now." }, { status: 503 }), new Response(null, { status: 204 }));
    const { user, dialog } = await open({ kind: "carpark", carpark: carpark(), shown: "x" });
    await user.click(within(dialog).getByRole("radio", { name: "It's closed or gone" }));
    await user.type(within(dialog).getByRole("textbox"), "Hoarding up");
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));
    expect(await within(dialog).findByText("Your report wasn't sent. Check your connection and try again. Your note is still here.")).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox")).toHaveValue("Hoarding up");
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));
    expect(await within(dialog).findByText("Your report wasn't sent. Feedback isn't available right now. Your note is still here.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));
    expect(await within(dialog).findByText("Thanks. Your report was sent to ParkWhere.")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sentBody(fetcher, 2).note).toBe("Hoarding up");
  });

  it("offers a public OpenStreetMap note only after sending a report about an OpenStreetMap carpark", async () => {
    respond(new Response(null, { status: 204 }));
    const { user, dialog } = await open({ kind: "carpark", carpark: osm, shown: "No live count" });
    expect(within(dialog).getByText("Mapped on OpenStreetMap · no count or rates")).toBeInTheDocument();
    expect(within(dialog).queryByRole("link", { name: /OpenStreetMap/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("radio", { name: "It isn't a carpark" }));
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));
    const link = await within(dialog).findByRole("link", { name: "Leave a note on OpenStreetMap ↗" });
    expect(link).toHaveAttribute("href", "https://www.openstreetmap.org/note/new#map=19/1.36041/103.98983");
    expect(within(dialog).getByText(/Anyone can read it\./)).toBeInTheDocument();
  });

  it("explains LTA counts before sending a count report", async () => {
    respond(new Response(null, { status: 204 }));
    const { user, dialog } = await open({ kind: "carpark", carpark: lta, shown: "967 car lots available, as reported by LTA, no time or total" });
    expect(within(dialog).queryByText(/can't correct LTA counts/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("radio", { name: "The count looks wrong" }));
    expect(within(dialog).getByText("ParkWhere can't correct LTA counts. Your report helps show how often they're off.")).toBeInTheDocument();
  });

  it("takes general feedback with a required message, starting on a missing carpark from 'Tell us'", async () => {
    const fetcher = respond(new Response(null, { status: 204 }));
    const { user, dialog } = await open({ kind: "general", reason: "missing" });
    expect(within(dialog).getByRole("radio", { name: "A carpark we've missed" })).toBeChecked();
    expect(within(dialog).getByText(/Where is it\? A name, address or nearby block is enough\./)).toBeInTheDocument();
    expect(within(dialog).getByText("0/1,000")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Send feedback" }));
    expect(within(dialog).getByText("Write a message.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Your message (required)"), "Open-air carpark behind Blk 12");
    await user.click(within(dialog).getByRole("button", { name: "Send feedback" }));
    expect(await within(dialog).findByText("Thanks. Your feedback was sent to ParkWhere.")).toBeInTheDocument();
    expect(sentBody(fetcher)).toMatchObject({ kind: "general", reason: "missing", carparkId: null, source: null, shown: null, note: "Open-air carpark behind Blk 12" });
  });

  it("explains how reports are used, with the privacy address, and that ParkWhere can't reply", async () => {
    const { dialog } = await open({ kind: "carpark", carpark: carpark(), shown: "x" });
    expect(within(dialog).getByText("ParkWhere can't reply to reports.")).toBeInTheDocument();
    expect(within(dialog).getByText("Leave out names, phone numbers and car plates.")).toBeInTheDocument();
    expect(within(dialog).getByText(/doesn't keep your IP address, device or location/)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "privacy@bijan.app" })).toHaveAttribute("href", "mailto:privacy@bijan.app");
  });
});
