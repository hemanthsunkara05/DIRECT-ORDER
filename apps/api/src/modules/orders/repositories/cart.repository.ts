import { Inject, Injectable } from '@nestjs/common';
import type { Cart, CartItem, CartStatus } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export type CartWithItems = Cart & { items: CartItem[] };

export interface CreateCartInput {
  restaurantId: string;
  guestTokenHash: string;
  expiresAt: Date;
  items: { menuItemId: string; quantity: number; unitPriceMinorAtAdd: bigint }[];
}

/**
 * `POST /public/carts` is a create-only operation in this phase (docs/04
 * §8.3: "Create/replace server cart") — a fresh Cart row with a fresh
 * guest token every call, not an in-place item replace against an
 * existing id. The frontend calls this once, right before checkout,
 * with its full locally-built cart; there is no scenario yet where a
 * customer needs to keep editing a server-persisted cart across visits.
 */
@Injectable()
export class CartRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateCartInput): Promise<CartWithItems> {
    return this.prisma.cart.create({
      data: {
        restaurantId: input.restaurantId,
        guestTokenHash: input.guestTokenHash,
        status: 'OPEN',
        expiresAt: input.expiresAt,
        items: {
          create: input.items.map((item) => ({
            menuItemId: item.menuItemId,
            quantity: item.quantity,
            unitPriceMinorAtAdd: item.unitPriceMinorAtAdd,
          })),
        },
      },
      include: { items: true },
    });
  }

  async findByIdWithItems(cartId: string): Promise<CartWithItems | null> {
    return this.prisma.cart.findUnique({ where: { id: cartId }, include: { items: true } });
  }

  async markStatus(cartId: string, status: CartStatus): Promise<void> {
    await this.prisma.cart.update({ where: { id: cartId }, data: { status } });
  }
}
