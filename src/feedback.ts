// Sends a feedback report to the Worker (worker/feedback.ts). Nothing is queued or kept on the device:
// a report that fails stays in the open sheet until it's sent or the sheet is closed.
import type { FeedbackBody } from "../shared/feedback";
import { withTimeout } from "./timeout";

const TIMEOUT_MS = 20_000;

export type SendResult = { ok: true } | { ok: false; reason: string };

/** Posts one report. "Sent" means the Worker answered 2xx, which it does only once the report is stored. */
export async function sendFeedback(body: FeedbackBody): Promise<SendResult> {
  const request = withTimeout(new AbortController().signal, TIMEOUT_MS);
  try {
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ ...body, appVersion: __APP_VERSION__ }),
      credentials: "same-origin",
      signal: request.signal
    });
    if (response.ok) return { ok: true };
    const answer = (await response.json().catch(() => null)) as { error?: unknown } | null;
    return { ok: false, reason: typeof answer?.error === "string" ? answer.error : `ParkWhere answered with HTTP ${response.status}.` };
  } catch {
    return { ok: false, reason: request.timedOut() ? "ParkWhere took too long to answer. Try again." : "Check your connection and try again." };
  } finally {
    request.clear();
  }
}
