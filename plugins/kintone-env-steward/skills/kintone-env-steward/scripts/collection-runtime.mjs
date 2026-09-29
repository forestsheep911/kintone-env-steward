export class CollectionError extends Error {
  constructor(status, message, httpStatus = null) {
    super(message); this.status = status; this.httpStatus = httpStatus;
  }
}
export function failureStatus(error) {
  if (["forbidden", "request-failed", "parse-failed", "unsupported"].includes(error?.status)) return error.status;
  if (error instanceof SyntaxError || /Unrecognized|Missing reviewed|Invalid reviewed|Unterminated reviewed|Malformed|directory numeric/.test(error?.message ?? "")) return "parse-failed";
  return "request-failed";
}
export const safeFailure = (error) => `${failureStatus(error)}${Number.isInteger(error?.httpStatus) ? ` (HTTP ${error.httpStatus})` : ""}`;
export function sourceStatus(resources, prefix) {
  const selected = resources.filter(({ key }) => key.startsWith(prefix));
  if (!selected.length || selected.every(({ status }) => status === "not-collected")) return "not-collected";
  return selected.every(({ status }) => status === "complete") ? "complete" : "partial";
}

// Reads only: both GET and the reviewed administration POST readers use this helper.
export async function readResponse(url, init = {}, {
  fetchImpl = fetch, timeoutMs = 30_000, attempts = 3,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    let timer;
    let retryDelay = Math.min(1000 * 2 ** attempt, 10_000);
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new CollectionError("request-failed", "Read timed out")); }, timeoutMs);
      });
      const result = await Promise.race([timeout, (async () => {
        const response = await fetchImpl(url, { ...init, redirect: "manual", signal: controller.signal });
        if (!response.ok) {
          const retryAfter = response.headers.get("retry-after");
          const seconds = retryAfter == null ? NaN : Number(retryAfter);
          const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(delay)) retryDelay = Math.max(retryDelay, Math.max(0, delay));
          const error = new CollectionError([401, 403].includes(response.status) ? "forbidden" : "request-failed", `HTTP ${response.status}`, response.status);
          error.retryable = response.status === 429 || [500, 502, 503, 504].includes(response.status);
          await response.body?.cancel();
          throw error;
        }
        return { status: response.status, text: await response.text(), contentType: response.headers.get("content-type") ?? "" };
      })()]);
      return result;
    } catch (error) {
      const retryable = error.retryable ?? !(error instanceof CollectionError && error.httpStatus != null);
      // Never retry earlier than Retry-After. Excessively long server delays end this resource.
      if (!retryable || attempt + 1 >= attempts || retryDelay > 30_000) {
        if (error instanceof CollectionError) throw error;
        throw new CollectionError("request-failed", "Read transport failed");
      }
    } finally { clearTimeout(timer); }
    await sleep(retryDelay);
  }
}
