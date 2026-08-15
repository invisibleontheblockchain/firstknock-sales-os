const DEFAULT_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function statusSet(value, fallback) {
  if (value === undefined) return fallback;
  return new Set(value);
}

function retryDelay(response, attempt, maxDelayMs) {
  const retryAfter = response?.headers?.get?.('retry-after');
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Math.min(maxDelayMs, Number(retryAfter) * 1000);
  }
  if (retryAfter) {
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.min(maxDelayMs, Math.max(0, retryAt - Date.now()));
  }
  return Math.min(maxDelayMs, 500 * (2 ** attempt) + Math.floor(Math.random() * 250));
}

export async function requestJson(url, options = {}, settings = {}) {
  const fetchImpl = settings.fetchImpl || fetch;
  const retries = Number.isInteger(settings.retries) ? settings.retries : 3;
  const timeoutMs = Number(settings.timeoutMs || 30_000);
  const retryableStatuses = statusSet(settings.retryableStatuses, DEFAULT_RETRYABLE_STATUS);
  const terminalStatuses = statusSet(settings.terminalStatuses, new Set());
  const retryNetworkErrors = settings.retryNetworkErrors !== false;
  const delayImpl = settings.delayImpl || ((delayMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs)));
  const maxRetryDelayMs = Math.max(0, Number(settings.maxRetryDelayMs ?? 20_000));
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text.slice(0, 1_000) };
        }
      }
      if (response.ok) return { response, body };
      const error = new Error(`Provider request failed with HTTP ${response.status}`);
      error.status = response.status;
      error.body = body;
      const canRetry = retryableStatuses.has(response.status) && !terminalStatuses.has(response.status);
      if (!canRetry || attempt === retries) throw error;
      await delayImpl(retryDelay(response, attempt, maxRetryDelayMs));
    } catch (error) {
      lastError = error;
      const responseCanRetry = error?.status
        && retryableStatuses.has(error.status)
        && !terminalStatuses.has(error.status);
      const canRetry = error?.status ? responseCanRetry : retryNetworkErrors;
      if (attempt === retries || !canRetry) throw error;
      await delayImpl(retryDelay(null, attempt, maxRetryDelayMs));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('Provider request failed');
}
