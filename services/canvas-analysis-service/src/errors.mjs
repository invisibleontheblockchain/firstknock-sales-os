export class ServiceError extends Error {
  constructor(status, code, message, { retryable = false, details = null } = {}) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function asServiceError(error, fallbackCode = 'canvas_analysis_internal_error') {
  if (error instanceof ServiceError) return error;
  return new ServiceError(500, fallbackCode, 'Canvas analysis encountered an internal error.');
}
