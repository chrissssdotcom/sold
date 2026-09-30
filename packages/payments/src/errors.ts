import { CommerceError, ConflictError } from '@sold/commerce';

export class PaymentError extends CommerceError {}

export class GatewayUnavailableError extends PaymentError {
  constructor(gatewayId: string) {
    super('gateway_unavailable', `Payment method "${gatewayId}" is not available`, 422, {
      gatewayId,
    });
  }
}

export class PaymentInProgressError extends ConflictError {
  constructor(orderId: string) {
    super('payment_in_progress', 'Another payment for this order is already in progress', {
      orderId,
    });
  }
}
