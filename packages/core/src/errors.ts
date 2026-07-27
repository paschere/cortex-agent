export class ZipdevError extends Error {
  constructor(message: string, public readonly code: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'ZipdevError';
  }
}
export class UnauthorizedError extends ZipdevError {
  constructor(msg = 'Unauthorized') { super(msg, 'UNAUTHORIZED'); }
}
export class ForbiddenError extends ZipdevError {
  constructor(msg = 'Forbidden') { super(msg, 'FORBIDDEN'); }
}
export class NotFoundError extends ZipdevError {
  constructor(msg = 'Not found') { super(msg, 'NOT_FOUND'); }
}
export class ValidationError extends ZipdevError {
  constructor(msg: string, cause?: unknown) { super(msg, 'VALIDATION', cause); }
}
export class IntegrationError extends ZipdevError {
  constructor(msg: string, public readonly provider: string, cause?: unknown) {
    super(msg, 'INTEGRATION_ERROR', cause);
  }
}
export class RateLimitError extends ZipdevError {
  constructor(msg = 'Rate limit exceeded') { super(msg, 'RATE_LIMITED'); }
}
export class ConfirmationRequiredError extends ZipdevError {
  constructor(public readonly toolId: string, public readonly input: unknown) {
    super(`Tool ${toolId} requires confirmation`, 'CONFIRMATION_REQUIRED');
  }
}
/**
 * Thrown by the security enforcement layer when a tool call is refused outright.
 *
 * The message is deliberately written as plain language for an end user: the
 * model relays it verbatim. It must say WHAT was blocked, WHY, and what the
 * human can do instead — never a stack trace, a policy key or a threshold.
 */
export class SecurityBlockedError extends ZipdevError {
  constructor(
    message: string,
    public readonly toolId: string,
    public readonly riskLevel: string,
    public readonly signals: string[] = [],
  ) {
    super(message, 'SECURITY_BLOCKED');
  }
}
