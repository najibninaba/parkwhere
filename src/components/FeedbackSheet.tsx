import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type SyntheticEvent } from "react";
import type { NearbyCarpark } from "../../shared/domain";
import { GENERAL_REASONS, NOTE_LIMIT, REASON_LABEL, reasonsFor, type FeedbackReason, type GeneralReason } from "../../shared/feedback";
import { sendFeedback } from "../feedback";
import { title } from "../format";

/** What the sheet is about: one carpark (from its card), or ParkWhere as a whole (from the footer). */
export type FeedbackTarget =
  | { kind: "carpark"; carpark: NearbyCarpark; /** What the card's count box showed when the sheet opened. */ shown: string; returnFocus?: HTMLElement | null }
  | { kind: "general"; reason?: GeneralReason; returnFocus?: HTMLElement | null };

interface Props {
  target: FeedbackTarget;
  onClose: () => void;
}

export const PRIVACY_EMAIL = "privacy@bijan.app";

const SOURCE_LINE = {
  hdb: "HDB carpark · count from data.gov.sg",
  lta: "Mall or development carpark · count from LTA DataMall",
  ura: "URA carpark · count from LTA DataMall",
  osm: "Mapped on OpenStreetMap · no count or rates"
} as const;

/** OpenStreetMap's "new note" page at the carpark. Note text can't be prefilled there. */
export const osmNoteUrl = (carpark: Pick<NearbyCarpark, "lat" | "lng">) =>
  `https://www.openstreetmap.org/note/new#map=19/${carpark.lat.toFixed(5)}/${carpark.lng.toFixed(5)}`;

function HowWeUseThis({ carpark }: { carpark: boolean }) {
  const thing = carpark ? "report" : "feedback";
  return (
    <details className="disclosure">
      <summary><span>How we use this</span></summary>
      <p>
        {carpark
          ? "ParkWhere keeps the carpark, the reason you chose, the date, your note and the app version. For a count report, it also keeps what the card showed."
          : "ParkWhere keeps the topic you chose, the date, your message and the app version."}{" "}
        It uses them to fix wrong or missing carparks and improve the app. It doesn't ask for your name or contact details, and doesn't keep your IP address, device or location.{" "}
        {carpark ? "Reports are" : "Feedback is"} stored with Cloudflare, which hosts ParkWhere. Only the maintainer reads {carpark ? "them" : "it"}, and your {carpark ? "note" : "message"} is never published. A fix it leads to may be.{" "}
        {carpark ? "Reports are" : "Feedback is"} deleted within 12 months, and backups within 30 days after that.
      </p>
      <p>
        To ask about or remove a {thing} you sent, email <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>.
      </p>
    </details>
  );
}

/**
 * The feedback sheet: a native modal dialog, a bottom sheet on phones and centred on wide screens. It says
 * "Sent" only after the Worker answers 2xx; a failure keeps the note and says so. Nothing is stored on the device.
 */
export function FeedbackSheet({ target, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const noteBox = useRef<HTMLTextAreaElement>(null);
  const bait = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const id = useId();
  const isCarpark = target.kind === "carpark";
  const carpark = target.kind === "carpark" ? target.carpark : null;
  const source = carpark?.source ?? "hdb";
  const reasons: readonly FeedbackReason[] = carpark ? reasonsFor(source) : GENERAL_REASONS;
  const [reason, setReason] = useState<FeedbackReason | null>(target.kind === "general" ? (target.reason ?? null) : null);
  const [note, setNote] = useState("");
  const [phase, setPhase] = useState<"editing" | "sending" | "sent">("editing");
  const [error, setError] = useState<string | null>(null);
  const limit = NOTE_LIMIT[target.kind];
  const noteRequired = !isCarpark || reason === "other";
  const thing = isCarpark ? "report" : "feedback";

  // Opens as a modal, focuses the chosen (or first) reason, and on close returns focus to what opened it.
  useEffect(() => {
    const element = dialog.current;
    const returnTo = target.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (element && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
    element?.querySelector<HTMLInputElement>('input[type="radio"]:checked, input[type="radio"]')?.focus();
    return () => {
      if (element?.open) {
        if (typeof element.close === "function") element.close();
        else element.removeAttribute("open");
      }
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
    // The target is fixed for the sheet's lifetime: App keys the sheet by target, so a new one remounts it.
  }, []);

  useEffect(() => {
    if (phase === "sent") heading.current?.focus();
  }, [phase]);

  const close = (event?: SyntheticEvent) => {
    event?.preventDefault();
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close(event);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending.current) return;
    if (!reason) {
      setError(isCarpark ? "Choose what's wrong." : "Choose what it's about.");
      dialog.current?.querySelector<HTMLInputElement>('input[type="radio"]')?.focus();
      return;
    }
    if (noteRequired && !note.trim()) {
      setError(isCarpark ? "Add a note to say what's wrong." : "Write a message.");
      noteBox.current?.focus();
      return;
    }
    sending.current = true;
    setPhase("sending");
    setError(null);
    const result = await sendFeedback({
      kind: target.kind,
      reason,
      carparkId: carpark?.id ?? null,
      source: carpark ? source : null,
      shown: target.kind === "carpark" && reason === "count" ? target.shown : null,
      note: note.trim() || null,
      website: bait.current?.value ?? ""
    });
    sending.current = false;
    if (result.ok) {
      setPhase("sent");
      return;
    }
    setPhase("editing");
    setError(`Your ${thing} wasn't sent. ${result.reason}${note.trim() ? ` Your ${isCarpark ? "note" : "message"} is still here.` : ""}`);
  };

  const place = carpark ? (source === "hdb" ? `${title(carpark.address)} (${carpark.id})` : carpark.address) : null;
  const sent = phase === "sent";
  const heading_ = sent ? (isCarpark ? "Report sent" : "Feedback sent") : isCarpark ? "Report a problem" : "Send feedback";
  const hint =
    reason === "missing"
      ? "Where is it? A name, address or nearby block is enough. Leave out names, phone numbers and car plates."
      : "Leave out names, phone numbers and car plates.";

  return (
    <dialog ref={dialog} className="sheet" aria-labelledby={`${id}-title`} onCancel={close} onKeyDown={onKeyDown}>
      <div className="sheet-top">
        <div className="sheet-title">
          <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{heading_}</h2>
          {place && <p className="sheet-place">{place}</p>}
          <p className="sheet-source">
            {carpark ? SOURCE_LINE[source] : "About ParkWhere as a whole. To report one carpark, use Report a problem on its card."}
          </p>
        </div>
        <button type="button" className="button icon-button" aria-label="Close" onClick={close}>
          ×
        </button>
      </div>
      <div className="sheet-rule" />

      {sent ? (
        <div className="sheet-body">
          <p className="banner banner-ok" role="status">
            Thanks. Your {thing} was sent to ParkWhere.
          </p>
          <p>ParkWhere checks {isCarpark ? "reports" : "feedback"} every week. It can't reply, because it doesn't ask who you are.</p>
          {carpark && source === "osm" && (
            <div className="sheet-osm">
              <p className="reply-line">This carpark is mapped on OpenStreetMap. You can also leave a public note there. Anyone can read it.</p>
              <p>
                <a className="link" href={osmNoteUrl(carpark)} target="_blank" rel="noopener noreferrer">
                  Leave a note on OpenStreetMap ↗
                </a>
              </p>
            </div>
          )}
          <button type="button" className="button button-primary button-block" onClick={close}>
            Done
          </button>
        </div>
      ) : (
        <form className="sheet-body" noValidate onSubmit={submit}>
          {/* Locked while sending, so nothing typed after Send is lost when the sheet turns to Sent. */}
          <fieldset className="radios" disabled={phase === "sending"}>
            <legend className="label">{isCarpark ? "What's wrong?" : "What's it about?"}</legend>
            <div className="radio-list">
              {reasons.map((option) => (
                <label key={option} className={`radio${reason === option ? " radio-checked" : ""}`}>
                  <input type="radio" name={`${id}-reason`} value={option} checked={reason === option} onChange={() => setReason(option)} />
                  <span>{REASON_LABEL[option]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {reason === "count" && target.kind === "carpark" && (
            <div className="sheet-notes">
              <p className="hint">Your report includes what the card showed: {target.shown}.</p>
              {(source === "lta" || source === "ura") && <p className="hint">ParkWhere can't correct LTA counts. Your report helps show how often they're off.</p>}
            </div>
          )}
          <div className="sheet-field">
            <label className="label" htmlFor={`${id}-note`}>
              {isCarpark ? `What did you see? (${noteRequired ? "required" : "optional"})` : "Your message (required)"}
            </label>
            <textarea
              id={`${id}-note`}
              ref={noteBox}
              maxLength={limit}
              rows={4}
              readOnly={phase === "sending"}
              value={note}
              required={noteRequired}
              onChange={(event) => setNote(event.target.value)}
              placeholder={isCarpark ? "e.g. Gantry closed for works on Sat 18 Oct, 3pm" : undefined}
              aria-describedby={`${id}-hint`}
            />
            <div className="field-foot">
              <p className="hint" id={`${id}-hint`}>{hint}</p>
              <span className="counter">
                {note.length}/{limit.toLocaleString("en-SG")}
              </span>
            </div>
          </div>
          {/*
            People never see or fill this in; a report with it filled is dropped by the Worker (sent as
            `website`). Its name and label are deliberately meaningless, so browser autofill and password
            managers leave it alone.
          */}
          <div className="bait" aria-hidden="true">
            <label>
              Leave this empty{" "}
              <input ref={bait} name="pw_extra" type="text" tabIndex={-1} autoComplete="off" data-1p-ignore="" data-lpignore="true" data-bwignore="" defaultValue="" />
            </label>
          </div>
          <div>
            <p className="reply-line">ParkWhere can't reply to {isCarpark ? "reports" : "feedback"}.</p>
            <HowWeUseThis carpark={isCarpark} />
          </div>
          <div aria-live="assertive">{error && <p className="banner banner-bad">{error}</p>}</div>
          <button type="submit" className="button button-primary button-block">
            {phase === "sending" ? "Sending…" : isCarpark ? "Send report" : "Send feedback"}
          </button>
        </form>
      )}
    </dialog>
  );
}
