/**
 * Domain errors carry a stable machine-readable `code` (safe to show storefronts) and an HTTP-ish
 * `status`, so route handlers map them without string matching.
 */
export class CommerceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends CommerceError {
  constructor(what: string, id: string) {
    super('not_found', `${what} not found`, 404, { what, id });
  }
}

export class ConflictError extends CommerceError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 409, details);
  }
}

export class ValidationError extends CommerceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation_failed', message, 422, details);
  }
}

export class InsufficientStockError extends ConflictError {
  constructor(variantId: string, requested: number, available: number) {
    super('insufficient_stock', 'Not enough stock available', { variantId, requested, available });
  }
}

/** A hook (interceptor) or business rule refused the operation. */
export class VetoError extends CommerceError {
  constructor(code: string, message: string) {
    super(code, message, 409);
  }
}
