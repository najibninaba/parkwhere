// Request helpers shared by the routes that accept a body (/api/event, /api/feedback).

/**
 * Whether a request comes from ParkWhere's own pages. Browsers send Sec-Fetch-Site and Origin and pages
 * can't forge them, so this keeps other sites from posting through a visitor's browser. A script can
 * still send anything: it's a filter, not authentication.
 */
export function sameOrigin(request: Request, url: URL): boolean {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (site !== null && site !== "same-origin") return false;
  if (origin !== null && origin !== url.origin) return false;
  return site !== null || origin !== null;
}

/** The body as text, or null once it passes `limit` bytes, read as it arrives so a large body is never buffered. */
export async function readCapped(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
