import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../platform/errors/app-error.js';
import { OrderRepository, type OrderWithRelations } from '../repositories/order.repository.js';
import { hashToken } from './cart.service.js';
import type { SerializedPricingBreakdown } from '../serialize-breakdown.js';

export interface OrderTrackingView {
  orderNumber: string;
  status: string;
  customerName: string;
  deliveryAddress: unknown;
  breakdown: SerializedPricingBreakdown;
  payableTotalMinor: string;
  items: {
    name: string;
    description: string | null;
    unitPriceMinor: string;
    quantity: number;
    lineTotalMinor: string;
  }[];
  history: { toStatus: string; createdAt: string }[];
  paymentStatus: string | null;
  createdAt: string;
}

/**
 * `GET /public/orders/:orderNumber?token=` (docs/04-api-specification.md
 * §8.3: "Requires ?token= access token or an owning session"). No
 * customer session exists yet (AMB-2: guest checkout is the pilot
 * default, a registered account is explicitly deferred past the pilot)
 * — so this phase only ever implements the guest-token branch. A
 * missing/wrong token is reported identically to a non-existent order
 * number (NotFoundError), so probing order numbers can't distinguish
 * "wrong token" from "doesn't exist" (BR-35).
 */
@Injectable()
export class OrderTrackingService {
  constructor(@Inject(OrderRepository) private readonly orders: OrderRepository) {}

  async getByOrderNumber(orderNumber: string, token: string): Promise<OrderTrackingView> {
    const order = await this.orders.findByOrderNumber(orderNumber);
    if (!order || order.accessTokenHash !== hashToken(token)) {
      throw new NotFoundError('Order not found.');
    }
    return toView(order);
  }
}

function toView(order: OrderWithRelations): OrderTrackingView {
  const latestPayment = order.payments[0];
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    customerName: order.customerName,
    deliveryAddress: order.deliveryAddress,
    breakdown: order.pricingBreakdown as unknown as SerializedPricingBreakdown,
    payableTotalMinor: order.payableTotalMinor.toString(),
    items: order.items.map((item) => ({
      name: item.nameSnapshot,
      description: item.descriptionSnapshot,
      unitPriceMinor: item.unitPriceMinorSnapshot.toString(),
      quantity: item.quantity,
      lineTotalMinor: item.lineTotalMinor.toString(),
    })),
    history: order.history.map((entry) => ({
      toStatus: entry.toStatus,
      createdAt: entry.createdAt.toISOString(),
    })),
    paymentStatus: latestPayment?.status ?? null,
    createdAt: order.createdAt.toISOString(),
  };
}
