import { Inject, Injectable } from '@nestjs/common';
import type {
  NotificationCategory,
  NotificationChannel,
  NotificationRecipientType,
} from '@prisma/client';
import { formatINR } from '@direct-order/money';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { OrderRepository } from '../../orders/repositories/order.repository.js';
import { CustomerRepository } from '../../orders/repositories/customer.repository.js';
import { PaymentRepository } from '../../payments/repositories/payment.repository.js';
import { RestaurantStaffRepository } from '../../restaurants/repositories/restaurant-staff.repository.js';

export interface NotificationDraft {
  type: string;
  category: NotificationCategory;
  recipientType: NotificationRecipientType;
  recipientId: string;
  channels: NotificationChannel[];
  title: string;
  body: string;
  phone: string | null;
  email: string | null;
}

/**
 * docs/08-search-and-notifications.md §14.4's catalogue, restricted to
 * the event types the codebase's EXISTING domains (orders, payments,
 * delivery) actually produce today — the catalogue's loyalty/referral/
 * review/support/promotion rows have no producer yet (those modules
 * don't exist), so they're not wired here; adding a resolver for an
 * event nothing emits would be dead code, not scope completeness.
 *
 * Every consumer re-reads current state rather than trusting the event
 * payload (docs/07 §11.2's "Ordering guarantees": "the payload is a
 * hint, never a source of truth") — every resolver below re-fetches the
 * Order/Customer/Restaurant/Payment rows it needs, not just formats the
 * event payload directly.
 */
@Injectable()
export class NotificationCatalogue {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrderRepository) private readonly orders: OrderRepository,
    @Inject(CustomerRepository) private readonly customers: CustomerRepository,
    @Inject(PaymentRepository) private readonly payments: PaymentRepository,
    @Inject(RestaurantStaffRepository) private readonly staff: RestaurantStaffRepository,
  ) {}

  async resolve(eventType: string, payload: unknown): Promise<NotificationDraft[]> {
    switch (eventType) {
      case 'ORDER_PLACED':
        return this.orderEvent(payload, {
          customer: {
            type: 'ORDER_PLACED_CUSTOMER',
            channels: ['IN_APP', 'SMS'],
            title: 'Order placed',
            body: (order) => `Your order ${order.orderNumber} has been placed.`,
          },
          restaurant: {
            type: 'ORDER_PLACED_RESTAURANT',
            channels: ['IN_APP', 'SMS', 'WHATSAPP'],
            title: 'New order',
            body: (order) =>
              `New order ${order.orderNumber} — ${formatINR(order.payableTotalMinor)}.`,
          },
        });
      case 'ORDER_ACCEPTED':
        return this.orderEvent(payload, {
          customer: {
            type: 'ORDER_ACCEPTED',
            channels: ['IN_APP', 'SMS'],
            title: 'Order accepted',
            body: (order) => `${order.restaurantName} accepted your order ${order.orderNumber}.`,
          },
        });
      case 'ORDER_REJECTED':
        return this.orderEvent(payload, {
          customer: {
            type: 'ORDER_REJECTED',
            channels: ['IN_APP', 'SMS'],
            title: 'Order rejected',
            body: (order) =>
              `${order.restaurantName} could not accept your order ${order.orderNumber}. A full refund has been initiated.`,
          },
        });
      case 'ORDER_PREPARING':
        return this.orderEvent(payload, {
          customer: {
            type: 'ORDER_PREPARING',
            channels: ['IN_APP'],
            title: 'Order in the kitchen',
            body: (order) =>
              `${order.restaurantName} is preparing your order ${order.orderNumber}.`,
          },
        });
      case 'ORDER_READY_FOR_PICKUP':
        return this.orderEvent(payload, {
          customer: {
            type: 'ORDER_READY',
            channels: ['IN_APP', 'SMS'],
            title: 'Order ready',
            body: (order) =>
              `Your order ${order.orderNumber} is ready and on its way to a courier.`,
          },
        });
      case 'ORDER_OUT_FOR_DELIVERY':
        return this.orderEvent(payload, {
          customer: {
            type: 'DELIVERY_OUT',
            channels: ['IN_APP', 'SMS'],
            title: 'Order out for delivery',
            body: (order) => `Order ${order.orderNumber} is on the way.`,
          },
        });
      case 'ORDER_DELIVERED':
        return this.orderEvent(payload, {
          customer: {
            type: 'ORDER_DELIVERED',
            channels: ['IN_APP', 'SMS'],
            title: 'Order delivered',
            body: (order) => `Order ${order.orderNumber} has been delivered. Enjoy!`,
          },
        });
      case 'ORDER_DELIVERY_FAILED':
        return this.orderEvent(payload, {
          restaurant: {
            type: 'DELIVERY_FAILED',
            channels: ['IN_APP', 'SMS'],
            title: 'Delivery failed',
            body: (order) => `Delivery failed for order ${order.orderNumber}.`,
          },
        });
      case 'ORDER_PAYMENT_FAILED':
        return this.orderEvent(payload, {
          customer: {
            type: 'PAYMENT_FAILED',
            channels: ['IN_APP', 'SMS'],
            title: 'Payment failed',
            body: (order) => `Payment for order ${order.orderNumber} did not go through.`,
          },
        });
      case 'REFUND_INITIATED':
        return this.refundEvent(payload, {
          type: 'REFUND_INITIATED',
          title: 'Refund initiated',
          body: (order, amountMinor) =>
            `A refund of ${formatINR(amountMinor)} for order ${order.orderNumber} has been initiated.`,
        });
      case 'REFUND_COMPLETED':
        return this.refundEvent(payload, {
          type: 'REFUND_COMPLETED',
          title: 'Refund completed',
          body: (order, amountMinor) =>
            `${formatINR(amountMinor)} has been refunded for order ${order.orderNumber}.`,
        });
      case 'DELIVERY_CREATION_FAILED':
        return this.deliveryCreationFailedEvent(payload);
      case 'DELIVERY_COURIER_ASSIGNED':
        return this.deliveryCourierAssignedEvent(payload);
      default:
        return [];
    }
  }

  private async orderEvent(
    payload: unknown,
    defs: {
      customer?: {
        type: string;
        channels: NotificationChannel[];
        title: string;
        body: (o: OrderContext) => string;
      };
      restaurant?: {
        type: string;
        channels: NotificationChannel[];
        title: string;
        body: (o: OrderContext) => string;
      };
    },
  ): Promise<NotificationDraft[]> {
    const orderId = (payload as { orderId?: string }).orderId;
    if (!orderId) return [];
    const order = await this.loadOrderContext(orderId);
    if (!order) return [];

    const drafts: NotificationDraft[] = [];
    if (defs.customer) {
      const customer = await this.customers.findById(order.customerId);
      if (customer) {
        drafts.push({
          type: defs.customer.type,
          category: 'TRANSACTIONAL',
          recipientType: 'CUSTOMER',
          recipientId: customer.id,
          channels: defs.customer.channels,
          title: defs.customer.title,
          body: defs.customer.body(order),
          phone: customer.phone,
          email: customer.email,
        });
      }
    }
    if (defs.restaurant) {
      drafts.push(
        ...(await this.restaurantDrafts(
          order.restaurantId,
          defs.restaurant.type,
          defs.restaurant.channels,
          defs.restaurant.title,
          defs.restaurant.body(order),
        )),
      );
    }
    return drafts;
  }

  private async refundEvent(
    payload: unknown,
    def: { type: string; title: string; body: (o: OrderContext, amountMinor: bigint) => string },
  ): Promise<NotificationDraft[]> {
    const p = payload as { paymentId?: string; orderId?: string; amountMinor?: string };
    const amountMinor = p.amountMinor ? BigInt(p.amountMinor) : 0n;
    let orderId = p.orderId;
    if (!orderId && p.paymentId) {
      const payment = await this.payments.findById(p.paymentId);
      orderId = payment?.orderId;
    }
    if (!orderId) return [];
    const order = await this.loadOrderContext(orderId);
    if (!order) return [];
    const customer = await this.customers.findById(order.customerId);
    if (!customer) return [];
    return [
      {
        type: def.type,
        category: 'TRANSACTIONAL',
        recipientType: 'CUSTOMER',
        recipientId: customer.id,
        channels: ['IN_APP', 'SMS'],
        title: def.title,
        body: def.body(order, amountMinor),
        phone: customer.phone,
        email: customer.email,
      },
    ];
  }

  private async deliveryCreationFailedEvent(payload: unknown): Promise<NotificationDraft[]> {
    const p = payload as { orderId?: string; orderNumber?: string; reason?: string };
    if (!p.orderId) return [];
    const order = await this.loadOrderContext(p.orderId);
    if (!order) return [];
    return this.restaurantDrafts(
      order.restaurantId,
      'DELIVERY_FAILED',
      ['IN_APP', 'SMS'],
      'Could not arrange delivery',
      `Delivery could not be arranged for order ${order.orderNumber}. It remains ready for pickup.`,
    );
  }

  private async deliveryCourierAssignedEvent(payload: unknown): Promise<NotificationDraft[]> {
    const p = payload as { orderId?: string; courierName?: string | null };
    if (!p.orderId) return [];
    const order = await this.loadOrderContext(p.orderId);
    if (!order) return [];
    const customer = await this.customers.findById(order.customerId);
    if (!customer) return [];
    return [
      {
        type: 'DELIVERY_ASSIGNED',
        category: 'TRANSACTIONAL',
        recipientType: 'CUSTOMER',
        recipientId: customer.id,
        channels: ['IN_APP', 'SMS'],
        title: 'Courier assigned',
        body: p.courierName
          ? `${p.courierName} is picking up your order ${order.orderNumber}.`
          : `A courier has been assigned to order ${order.orderNumber}.`,
        phone: customer.phone,
        email: customer.email,
      },
    ];
  }

  /** Every ACTIVE staff member of the restaurant gets their own Notification row — the dedupe key already scopes by `recipientId`, so this is never a fan-out bug. */
  private async restaurantDrafts(
    restaurantId: string,
    type: string,
    channels: NotificationChannel[],
    title: string,
    body: string,
  ): Promise<NotificationDraft[]> {
    const staff = await this.staff.listWithUser(restaurantId, { limit: 100 });
    return staff
      .filter((s) => s.status === 'ACTIVE')
      .map((s) => ({
        type,
        category: 'TRANSACTIONAL' as const,
        recipientType: 'RESTAURANT_USER' as const,
        recipientId: s.userId,
        channels,
        title,
        body,
        phone: s.user.phone,
        email: s.user.email,
      }));
  }

  private async loadOrderContext(orderId: string): Promise<OrderContext | null> {
    const order = await this.orders.findById(orderId);
    if (!order) return null;
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: order.restaurantId },
    });
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      restaurantId: order.restaurantId,
      restaurantName: restaurant?.name ?? 'the restaurant',
      payableTotalMinor: order.payableTotalMinor,
    };
  }
}

interface OrderContext {
  orderId: string;
  orderNumber: string;
  customerId: string;
  restaurantId: string;
  restaurantName: string;
  payableTotalMinor: bigint;
}
