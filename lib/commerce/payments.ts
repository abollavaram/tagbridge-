import Stripe from 'stripe';

/**
 * Card payment, behind an interface.
 *
 * The interface exists so the checkout flow can be tested without a Stripe
 * account, and so a deployment with no key configured fails with a clear
 * message at the point of use rather than at import time.
 */

export interface CheckoutLine {
  name: string;
  sku: string;
  qty: number;
  /** Server-computed. There is no path by which a caller supplies this. */
  unitPriceCents: number;
}

export interface CheckoutSessionRequest {
  orderId: string;
  orderNumber: string;
  email: string;
  lines: readonly CheckoutLine[];
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  id: string;
  url: string;
}

export interface PaymentProvider {
  readonly configured: boolean;
  createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession>;
}

export class PaymentNotConfiguredError extends Error {
  constructor() {
    super('Card payment is not configured on this deployment.');
    this.name = 'PaymentNotConfiguredError';
  }
}

export const unconfiguredProvider: PaymentProvider = {
  configured: false,
  createCheckoutSession(): Promise<CheckoutSession> {
    return Promise.reject(new PaymentNotConfiguredError());
  },
};

export function stripeProvider(secretKey: string): PaymentProvider {
  const stripe = new Stripe(secretKey, { apiVersion: '2026-08-26.dahlia' });
  return {
    configured: true,
    async createCheckoutSession(request) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: request.email,
        client_reference_id: request.orderId,
        line_items: request.lines.map((line) => ({
          quantity: line.qty,
          price_data: {
            currency: 'usd',
            unit_amount: line.unitPriceCents,
            product_data: { name: line.name, description: line.sku },
          },
        })),
        metadata: { orderId: request.orderId, orderNumber: request.orderNumber },
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
      });
      if (!session.url) throw new Error('Stripe returned a session with no URL');
      return { id: session.id, url: session.url };
    },
  };
}

export function getPaymentProvider(): PaymentProvider {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? stripeProvider(key) : unconfiguredProvider;
}
