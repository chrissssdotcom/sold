import { CommerceError } from '@sold/commerce';

export class AuthError extends CommerceError {}

/** One message for every login failure: never reveal whether the account exists. */
export class InvalidCredentialsError extends AuthError {
  constructor() {
    super('invalid_credentials', 'Incorrect email or password', 401);
  }
}
export class AccountLockedError extends AuthError {
  constructor(readonly retryAfterSeconds: number) {
    super('too_many_attempts', 'Too many attempts. Try again later.', 429, { retryAfterSeconds });
  }
}
export class ForbiddenError extends AuthError {
  constructor(permission: string) {
    super('forbidden', 'You do not have permission to do that', 403, { permission });
  }
}
export class UnauthenticatedError extends AuthError {
  constructor() {
    super('unauthenticated', 'Sign in to continue', 401);
  }
}
