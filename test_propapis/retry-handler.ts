/**
 * retry-handler.ts
 * Implements exponential backoff for rate-limited requests
 */

export async function withRetry<T>(
  fn: () => Promise<T>, 
  maxRetries = 5, 
  baseDelay = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (error.message?.includes("429")) {
        const delay = baseDelay * Math.pow(2, i) + Math.random() * 100;
        console.warn(`Rate limited. Retrying in ${Math.round(delay)}ms...`);
        await new Promise(res => setTimeout(res, delay));
      } else {
        throw error;
      }
    }
  }
  throw lastError || new Error("Max retries exceeded");
}
