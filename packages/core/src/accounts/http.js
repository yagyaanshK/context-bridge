export const DEFAULT_PROVIDER_TIMEOUT_MS = 20_000;

// Provider endpoints are outside our control. Bound every request and race the
// fetch promise explicitly because injected/test fetch implementations may
// ignore AbortSignal even though the platform implementation does not.
export async function providerFetch(url, init = {}, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available.');

  const timeoutMs = Number.isFinite(options.requestTimeoutMs)
    ? Math.max(1, options.requestTimeoutMs)
    : DEFAULT_PROVIDER_TIMEOUT_MS;
  const externalSignal = options.signal || init.signal;
  if (externalSignal?.aborted) throw abortReason(externalSignal);

  const controller = new AbortController();
  let timedOut = false;
  let rejectAbort;
  const aborted = new Promise((resolve, reject) => {
    rejectAbort = reject;
  });
  aborted.catch(() => {});

  const onExternalAbort = () => {
    controller.abort(externalSignal.reason);
    rejectAbort(abortReason(externalSignal));
  };
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    const error = timeoutError(timeoutMs);
    controller.abort(error);
    rejectAbort(error);
  }, timeoutMs);
  const request = Promise.resolve().then(() => fetchImpl(url, { ...init, signal: controller.signal }));
  // A fetch implementation can reject after the timeout race has already won.
  request.catch(() => {});

  try {
    return await Promise.race([request, aborted]);
  } catch (error) {
    if (timedOut && error?.code !== 'ETIMEDOUT') throw timeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

function timeoutError(timeoutMs) {
  const error = new Error(`Provider request timed out after ${timeoutMs} ms.`);
  error.code = 'ETIMEDOUT';
  return error;
}

function abortReason(signal) {
  if (signal?.reason instanceof Error && signal.reason.name !== 'AbortError') return signal.reason;
  const error = new Error('Provider request cancelled.');
  error.name = 'AbortError';
  return error;
}
