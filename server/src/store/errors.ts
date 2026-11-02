export class StoreError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    status = 503,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
