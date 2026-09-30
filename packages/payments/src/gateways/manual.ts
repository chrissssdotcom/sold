import {
  WebhookVerificationError,
  type CreatePaymentRequest,
  type CreatePaymentResult,
  type GatewayEvent,
  type GatewayRefundRequest,
  type GatewayRefundResult,
  type PaymentGateway,
} from '../gateway';

export interface ManualGatewayOptions {
  id?: string;
  displayName?: string;
  /** Shown to the shopper (bank details, "pay on delivery"). */
  instructions?: string;
}

/**
 * Offline payment (bank transfer, cash on delivery, invoice). Nothing is charged: the order waits for an admin to
 * confirm receipt (`PaymentService.confirmManually`). The zero-configuration default gateway of a fresh instance.
 */
export class ManualGateway implements PaymentGateway {
  readonly id: string;
  readonly displayName: string;
  private readonly instructions: string;

  constructor(opts: ManualGatewayOptions = {}) {
    this.id = opts.id ?? 'manual';
    this.displayName = opts.displayName ?? 'Bank transfer / pay on delivery';
    this.instructions = opts.instructions ?? 'We will contact you with payment instructions.';
  }

  supportsCurrency(): boolean {
    return true;
  }

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    return {
      gatewayRef: `manual_${req.paymentId}`,
      status: 'pending',
      instructions: this.instructions,
    };
  }

  async refund(req: GatewayRefundRequest): Promise<GatewayRefundResult> {
    // The money is returned by hand; recording the refund is what we do.
    return { refundRef: `manual_refund_${req.idempotencyKey}`, status: 'succeeded' };
  }

  parseWebhook(): GatewayEvent[] {
    throw new WebhookVerificationError('The manual gateway has no webhooks');
  }
}
