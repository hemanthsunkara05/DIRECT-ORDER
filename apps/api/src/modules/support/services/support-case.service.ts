import { Inject, Injectable } from '@nestjs/common';
import type { SupportCase, SupportCaseCategory, SupportCaseStatus, SupportMessage } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../../platform/errors/app-error.js';
import { OutboxService } from '../../../platform/outbox/outbox.service.js';
import { OrderRepository } from '../../orders/repositories/order.repository.js';
import { SupportCaseRepository, generateCaseNumber } from '../repositories/support-case.repository.js';
import { SupportMessageRepository } from '../repositories/support-message.repository.js';
import { SupportAttachmentService, type AttachInput } from './support-attachment.service.js';

export interface CreateCaseInput {
  category: SupportCaseCategory;
  subject: string;
  description: string;
  /** Public order number, never a raw internal id — resolved and ownership-checked here (BR-134/BR-135), not trusted from the client as anything more than a lookup key. */
  orderNumber?: string;
}

/**
 * docs/03-state-machines.md §7.9's exact state machine, docs/06-
 * business-rules.md BR-134..BR-140. The single service every
 * `SupportCase`/`SupportMessage` write goes through — the same "one
 * service per aggregate" boundary `OrderStateService` established —
 * so the status-transition and visibility rules below can never be
 * bypassed by a controller reaching for the repository directly.
 */
@Injectable()
export class SupportCaseService {
  constructor(
    @Inject(SupportCaseRepository) private readonly cases: SupportCaseRepository,
    @Inject(SupportMessageRepository) private readonly messages: SupportMessageRepository,
    @Inject(SupportAttachmentService) private readonly attachments: SupportAttachmentService,
    @Inject(OrderRepository) private readonly orders: OrderRepository,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  /** BR-134: "customers may only open cases against their own orders" — `orderNumber` is resolved and its ownership verified HERE, against the live `Order` row, never trusted from the client as anything more than a lookup key (docs/04's own "never a client-supplied identifier" posture, BR-148). A wrong or nonexistent order number is `VALIDATION_ERROR`, not silently ignored — a customer referencing an order should never end up with a case quietly detached from it. */
  async createForCustomer(customerId: string, input: CreateCaseInput): Promise<SupportCase> {
    const orderId = input.orderNumber
      ? await this.resolveOwnedOrderId(input.orderNumber, (order) => order.customerId === customerId)
      : undefined;
    const created = await this.cases.create({
      caseNumber: generateCaseNumber(),
      customerId,
      orderId,
      category: input.category,
      subject: input.subject,
      description: input.description,
    });
    await this.outbox.record('SUPPORT_CASE_CREATED', {
      caseId: created.id,
      category: created.category,
      priority: created.priority,
    });
    return created;
  }

  /** BR-135: "restaurants may only open and view cases for their own restaurant" — `restaurantId` always comes from `TenantContext`, never a client-supplied field, the same "ownerId in body ignored" pattern used throughout this codebase; `orderNumber`, if given, is verified to belong to that same restaurant. */
  async createForRestaurant(restaurantId: string, input: CreateCaseInput): Promise<SupportCase> {
    const orderId = input.orderNumber
      ? await this.resolveOwnedOrderId(input.orderNumber, (order) => order.restaurantId === restaurantId)
      : undefined;
    const created = await this.cases.create({
      caseNumber: generateCaseNumber(),
      restaurantId,
      orderId,
      category: input.category,
      subject: input.subject,
      description: input.description,
    });
    await this.outbox.record('SUPPORT_CASE_CREATED', {
      caseId: created.id,
      category: created.category,
      priority: created.priority,
    });
    return created;
  }

  /** Guest complaint path (`PublicSupportController`) — cases for one order, scoped to the guest `customerId` proven by their tracking-link token. */
  async listForCustomerOrder(customerId: string, orderId: string): Promise<{ items: SupportCase[]; hasMore: boolean }> {
    return this.cases.listForCustomerOrder(customerId, orderId);
  }

  private async resolveOwnedOrderId(
    orderNumber: string,
    owns: (order: { customerId: string; restaurantId: string }) => boolean,
  ): Promise<string> {
    const order = await this.orders.findByOrderNumber(orderNumber);
    if (!order || !owns(order)) {
      throw new ValidationError('orderNumber does not refer to an order you have access to.');
    }
    return order.id;
  }

  async postAsCustomer(
    supportCase: SupportCase,
    customerId: string,
    body: string,
    attachmentInputs: AttachInput[] = [],
  ): Promise<SupportMessage> {
    await this.postReply(supportCase, 'WAITING_CUSTOMER');
    const message = await this.messages.create({ caseId: supportCase.id, authorType: 'CUSTOMER', authorId: customerId, visibility: 'PUBLIC', body });
    await this.attachments.attachToMessage(supportCase.id, message.id, 'CUSTOMER', customerId, attachmentInputs);
    return message;
  }

  async postAsRestaurant(
    supportCase: SupportCase,
    userId: string,
    body: string,
    attachmentInputs: AttachInput[] = [],
  ): Promise<SupportMessage> {
    await this.postReply(supportCase, 'WAITING_RESTAURANT');
    const message = await this.messages.create({ caseId: supportCase.id, authorType: 'RESTAURANT', authorId: userId, visibility: 'PUBLIC', body });
    await this.attachments.attachToMessage(supportCase.id, message.id, 'RESTAURANT', userId, attachmentInputs);
    return message;
  }

  /**
   * The only path that can write an INTERNAL message — `visibility` is
   * caller-specified here (unlike the two methods above, which hard-
   * code PUBLIC), because only an admin/agent principal ever reaches
   * this method (`AdminSupportController`, gated on `support:
   * internal_notes`/`support:read` at the controller layer).
   */
  async postAsAgent(
    supportCase: SupportCase,
    agentUserId: string,
    body: string,
    visibility: 'INTERNAL' | 'PUBLIC',
    attachmentInputs: AttachInput[] = [],
  ): Promise<SupportMessage> {
    if (supportCase.status === 'CLOSED') {
      throw new ConflictError('This case is closed.');
    }
    if (supportCase.status === 'ASSIGNED' || supportCase.status === 'RESOLVED') {
      await this.cases.updateStatus(supportCase.id, 'IN_PROGRESS');
    }

    const message = await this.messages.create({
      caseId: supportCase.id,
      authorType: 'AGENT',
      authorId: agentUserId,
      visibility,
      body,
    });
    await this.attachments.attachToMessage(supportCase.id, message.id, 'AGENT', agentUserId, attachmentInputs);

    if (visibility === 'PUBLIC') {
      if (!supportCase.firstResponseAt) {
        await this.cases.setFirstResponseAt(supportCase.id, new Date());
      }
      // docs/03 §7.9: "IN_PROGRESS -> WAITING_CUSTOMER: awaiting
      // customer" / "-> WAITING_RESTAURANT: awaiting restaurant" — a
      // PUBLIC agent reply puts the ball back in the reporter's court,
      // pausing the SLA clock until they respond (`postReply`'s own
      // `matchingWaitStatus` check below is the other half of this
      // pair: it only ever fires once a case can actually REACH a
      // WAITING_* state, which is here). Never fires for an INTERNAL
      // note, which isn't addressed to the reporter at all.
      await this.cases.updateStatus(
        supportCase.id,
        supportCase.customerId ? 'WAITING_CUSTOMER' : 'WAITING_RESTAURANT',
      );
    }
    return message;
  }

  async assign(supportCase: SupportCase, assignedToUserId: string): Promise<SupportCase> {
    return this.cases.assign(supportCase.id, assignedToUserId);
  }

  async resolve(supportCase: SupportCase, resolutionNote: string): Promise<SupportCase> {
    if (supportCase.status === 'CLOSED') {
      throw new ConflictError('This case is already closed.');
    }
    return this.cases.resolve(supportCase.id, resolutionNote);
  }

  async requireForCustomer(id: string, customerId: string): Promise<SupportCase> {
    const found = await this.cases.findByIdForCustomer(id, customerId);
    if (!found) throw new NotFoundError('Support case not found.');
    return found;
  }

  async requireForRestaurant(id: string, restaurantId: string): Promise<SupportCase> {
    const found = await this.cases.findByIdForRestaurant(id, restaurantId);
    if (!found) throw new NotFoundError('Support case not found.');
    return found;
  }

  async requireById(id: string): Promise<SupportCase> {
    const found = await this.cases.findById(id);
    if (!found) throw new NotFoundError('Support case not found.');
    return found;
  }

  /**
   * Shared precondition + status-transition logic for the two
   * customer-/restaurant-facing reply methods above. `CLOSED` blocks a
   * reply outright; `RESOLVED` reopens (docs/03 §7.9: "RESOLVED ->
   * IN_PROGRESS: reopened"); the matching `WAITING_*` state transitions
   * to `IN_PROGRESS` on the matching party's reply — any OTHER status
   * (OPEN, ASSIGNED, IN_PROGRESS, or a non-matching WAITING_* state) is
   * left unchanged by a customer/restaurant reply, exactly as the
   * state diagram draws it.
   */
  private async postReply(supportCase: SupportCase, matchingWaitStatus: SupportCaseStatus): Promise<void> {
    if (supportCase.status === 'CLOSED') {
      throw new ConflictError('This case is closed.');
    }
    if (supportCase.status === matchingWaitStatus || supportCase.status === 'RESOLVED') {
      await this.cases.updateStatus(supportCase.id, 'IN_PROGRESS');
    }
  }
}
