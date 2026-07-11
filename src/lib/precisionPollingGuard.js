/** Keep interval-based job polling single-flight and completion-once per job. */
export function createPrecisionPollingGuard() {
  const inFlight = new Set();
  const completed = new Set();

  return {
    begin(jobId) {
      const key = String(jobId || '');
      if (!key || completed.has(key) || inFlight.has(key)) return false;
      inFlight.add(key);
      return true;
    },
    end(jobId) {
      inFlight.delete(String(jobId || ''));
    },
    claimCompletion(jobId) {
      const key = String(jobId || '');
      if (!key || completed.has(key)) return false;
      completed.add(key);
      return true;
    },
    releaseCompletion(jobId) {
      completed.delete(String(jobId || ''));
    },
    hasCompleted(jobId) {
      return completed.has(String(jobId || ''));
    }
  };
}
