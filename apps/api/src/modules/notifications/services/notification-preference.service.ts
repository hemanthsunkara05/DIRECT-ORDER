import { Inject, Injectable } from '@nestjs/common';
import type {
  NotificationCategory,
  NotificationChannel,
  NotificationPreference,
  NotificationRecipientType,
} from '@prisma/client';
import { ConflictError } from '../../../platform/errors/app-error.js';
import { CustomerRepository } from '../../orders/repositories/customer.repository.js';
import { NotificationPreferenceRepository } from '../repositories/notification-preference.repository.js';

/** docs/08 §14.3: TRANSACTIONAL and SECURITY are never disableable. */
const NON_DISABLEABLE: ReadonlySet<NotificationCategory> = new Set(['SECURITY', 'TRANSACTIONAL']);

/**
 * The one place a preference gets read or written — `NotificationDispatchService`
 * calls `isEnabled`, the `/me/notification-preferences` controller calls
 * `list`/`update`. `update` is where the non-disableable rule is
 * actually enforced (docs/14-acceptance-criteria.md: "A transactional
 * preference cannot be disabled via the API") — a row for a
 * non-disableable category is simply never written with `enabled:
 * false`, so there is no state to accidentally honor even if a caller
 * bypassed this service.
 */
@Injectable()
export class NotificationPreferenceService {
  constructor(
    @Inject(NotificationPreferenceRepository)
    private readonly preferences: NotificationPreferenceRepository,
    @Inject(CustomerRepository) private readonly customers: CustomerRepository,
  ) {}

  /**
   * BR-129: "Marketing notifications require explicit consent; account
   * creation is not consent." Only `Customer` models consent
   * (`marketingConsentAt`) today, and no MARKETING-category
   * notification is wired to any other recipient type yet (see
   * `NotificationCatalogue`'s own doc comment) — so a non-CUSTOMER
   * recipient is a safe, inert `false`, not a gap.
   */
  async hasMarketingConsent(
    recipientType: NotificationRecipientType,
    recipientId: string,
  ): Promise<boolean> {
    if (recipientType !== 'CUSTOMER') return false;
    const customer = await this.customers.findById(recipientId);
    return Boolean(customer?.marketingConsentAt);
  }

  async list(
    recipientType: NotificationRecipientType,
    recipientId: string,
  ): Promise<NotificationPreference[]> {
    return this.preferences.listForRecipient(recipientType, recipientId);
  }

  /** Defaults to enabled — a preference row only exists once someone has actually changed it (docs/01 §5.13's `enabled` default mirrors this: opt-out, not opt-in, for every non-MARKETING category). */
  async isEnabled(
    recipientType: NotificationRecipientType,
    recipientId: string,
    category: NotificationCategory,
    channel: NotificationChannel,
  ): Promise<boolean> {
    if (NON_DISABLEABLE.has(category)) return true;
    const pref = await this.preferences.findOne(recipientType, recipientId, category, channel);
    return pref?.enabled ?? category !== 'MARKETING'; // MARKETING defaults to opt-out (BR-129: consent required separately, checked by the caller)
  }

  async update(
    recipientType: NotificationRecipientType,
    recipientId: string,
    category: NotificationCategory,
    channel: NotificationChannel,
    enabled: boolean,
  ): Promise<NotificationPreference> {
    if (NON_DISABLEABLE.has(category) && !enabled) {
      throw new ConflictError(`${category} notifications cannot be disabled.`);
    }
    return this.preferences.upsert(recipientType, recipientId, category, channel, enabled);
  }
}
