// A request signal with a timeout, without AbortSignal.any (missing before Safari 17.4 / iOS 17.4).
export function withTimeout(parent: AbortSignal, ms: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  const onAbort = () => controller.abort();
  if (parent.aborted) controller.abort();
  else parent.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
    }
  };
}
