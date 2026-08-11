import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../src/platform/database/prisma.service.js';

/**
 * A minimal, in-memory stand-in for PrismaService covering exactly the
 * query shapes Phase 3's repositories issue (User, Session, OtpChallenge,
 * AuditLog). Exists because this sandbox has no Docker / live Postgres
 * (see every prior phase report) — it lets the full HTTP-level auth
 * flow (register → verify → login → refresh → logout) be exercised
 * end-to-end against real repository/service/controller code, with only
 * the database itself faked. It is intentionally NOT a general Prisma
 * mock: it implements the specific `where`/`data` shapes this codebase's
 * repositories send, nothing more.
 */

/**
 * Real Prisma Client treats an explicit `undefined` value in a `data`
 * object as "field not provided" — it's stripped before the SQL is even
 * built, so the column keeps its default/existing value. Plain object
 * spread and `Object.assign` do NOT do this: `{...defaults, ...{a:
 * undefined}}` overwrites `defaults.a` with `undefined`, and a service
 * that always passes a key through (`{ description: input.description }`
 * where `input.description` is an omitted optional field) hits this on
 * every create/update call here. Every merge of a caller's `data` object
 * in this file goes through this first, to match real Prisma's actual
 * behavior instead of plain JS spread semantics — a real, previously
 * unnoticed test-infrastructure bug found via Phase 7's public-API field
 * allowlist test, which was the first test to assert on a response's
 * exact key set rather than just individual field values.
 */
function omitUndefined<T extends object>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}

interface UserRow {
  id: string;
  email: string | null;
  phone: string | null;
  passwordHash: string | null;
  fullName: string;
  status: 'ACTIVE' | 'DISABLED';
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
  mfaSecret: string | null;
  mfaEnabledAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SessionRow {
  id: string;
  userId: string;
  familyId: string;
  refreshTokenHash: string;
  userAgent: string | null;
  ipHash: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  rotatedFromId: string | null;
  mfaVerifiedAt: Date | null;
  createdAt: Date;
}

interface OtpChallengeRow {
  id: string;
  identifier: string;
  purpose: string;
  codeHash: string;
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

interface AuditLogRow {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  restaurantId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  correlationId: string | null;
  ipHash: string | null;
  createdAt: Date;
}

export interface RestaurantRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  phone: string | null;
  email: string | null;
  timezone: string;
  status: string;
  onboardingStatus: string;
  orderingEnabled: boolean;
  avgPrepMinutes: number | null;
  ratingAvg: number | null;
  ratingCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RestaurantStaffRow {
  id: string;
  userId: string;
  restaurantId: string;
  role: 'STAFF' | 'MANAGER' | 'OWNER';
  status: 'ACTIVE' | 'DISABLED';
  invitedByUserId: string | null;
  joinedAt: Date;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RestaurantAddressRow {
  id: string;
  restaurantId: string;
  line1: string;
  line2: string | null;
  locality: string | null;
  city: string;
  state: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
  landmark: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RestaurantBrandingRow {
  id: string;
  restaurantId: string;
  logoUrl: string | null;
  coverImageUrl: string | null;
  themePrimaryColor: string | null;
  themeAccentColor: string | null;
  tagline: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RestaurantSettingsRow {
  id: string;
  restaurantId: string;
  minOrderAmountMinor: bigint;
  packagingFeeMinor: bigint;
  deliveryFeeMode: string;
  deliveryFeeFlatMinor: bigint;
  acceptsOnlinePayment: boolean;
  autoAcceptOrders: boolean;
  notificationEmails: string[];
  notificationPhones: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface StaffInvitationRow {
  id: string;
  restaurantId: string;
  email: string;
  role: 'STAFF' | 'MANAGER' | 'OWNER';
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  tokenHash: string;
  invitedByUserId: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface MenuCategoryRow {
  id: string;
  restaurantId: string;
  name: string;
  description: string | null;
  displayOrder: number;
  isActive: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MenuItemRow {
  id: string;
  restaurantId: string;
  categoryId: string;
  name: string;
  description: string | null;
  priceMinor: bigint;
  currency: string;
  imageUrl: string | null;
  isAvailable: boolean;
  isActive: boolean;
  displayOrder: number;
  dietaryTag: 'VEG' | 'NON_VEG' | 'EGG' | 'UNKNOWN';
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OperatingHoursRow {
  id: string;
  restaurantId: string;
  dayOfWeek: number;
  opensAt: Date;
  closesAt: Date;
  isClosed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SpecialHoursRow {
  id: string;
  restaurantId: string;
  date: Date;
  isClosed: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClosurePeriodRow {
  id: string;
  restaurantId: string;
  startsAt: Date;
  endsAt: Date | null;
  reason: string | null;
  createdByUserId: string;
  createdAt: Date;
}

export interface CustomerRow {
  id: string;
  userId: string | null;
  fullName: string;
  phone: string;
  email: string | null;
  status: 'ACTIVE' | 'DISABLED';
  marketingConsentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CartRow {
  id: string;
  restaurantId: string;
  customerId: string | null;
  guestTokenHash: string;
  status: 'OPEN' | 'CONVERTED' | 'ABANDONED';
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CartItemRow {
  id: string;
  cartId: string;
  menuItemId: string;
  quantity: number;
  unitPriceMinorAtAdd: bigint;
  createdAt: Date;
}

export interface OrderRow {
  id: string;
  orderNumber: string;
  restaurantId: string;
  customerId: string;
  status: string;
  customerName: string;
  customerPhone: string;
  deliveryAddress: unknown;
  itemsSubtotalMinor: bigint;
  packagingFeeMinor: bigint;
  deliveryFeeMinor: bigint;
  platformFeeMinor: bigint;
  taxMinor: bigint;
  discountMinor: bigint;
  loyaltyDiscountMinor: bigint;
  payableTotalMinor: bigint;
  currency: string;
  pricingBreakdown: unknown;
  promotionId: string | null;
  couponCode: string | null;
  appliedLoyaltyPoints: number;
  idempotencyKey: string;
  accessTokenHash: string;
  placedAt: Date | null;
  acceptedAt: Date | null;
  readyAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  rejectionReason: string | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderItemRow {
  id: string;
  orderId: string;
  menuItemId: string;
  nameSnapshot: string;
  descriptionSnapshot: string | null;
  unitPriceMinorSnapshot: bigint;
  quantity: number;
  lineTotalMinor: bigint;
  createdAt: Date;
}

export interface OrderStatusHistoryRow {
  id: string;
  orderId: string;
  fromStatus: string | null;
  toStatus: string;
  actorType: string;
  actorId: string | null;
  reason: string | null;
  metadata: unknown;
  createdAt: Date;
}

export interface PaymentRow {
  id: string;
  orderId: string;
  provider: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  status: string;
  amountMinor: bigint;
  capturedMinor: bigint;
  refundedMinor: bigint;
  currency: string;
  method: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  idempotencyKey: string;
  reconciliationStatus: string;
  authorizedAt: Date | null;
  capturedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefundRow {
  id: string;
  paymentId: string;
  orderId: string;
  amountMinor: bigint;
  reason: string;
  status: string;
  providerRefundId: string | null;
  initiatedByActorType: string;
  initiatedByActorId: string | null;
  idempotencyKey: string;
  completedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookEventRow {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  signatureValid: boolean;
  payload: unknown;
  status: string;
  attempts: number;
  lastError: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface ReconciliationIssueRow {
  id: string;
  entityType: string;
  entityId: string;
  issueType: string;
  expected: string | null;
  actual: string | null;
  severity: string;
  status: string;
  resolutionNote: string | null;
  resolvedBy: string | null;
  detectedAt: Date;
}

export interface DeliveryRow {
  id: string;
  orderId: string;
  provider: string;
  providerDeliveryId: string | null;
  status: string;
  pickupAddress: unknown;
  dropoffAddress: unknown;
  courierName: string | null;
  courierPhone: string | null;
  trackingUrl: string | null;
  quotedFeeMinor: bigint | null;
  actualFeeMinor: bigint | null;
  idempotencyKey: string;
  attemptCount: number;
  estimatedPickupAt: Date | null;
  estimatedDeliveryAt: Date | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  cancellationReason: string | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminUserRow {
  id: string;
  userId: string;
  role: string;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: Date;
  updatedAt: Date;
}

export interface PromotionRow {
  id: string;
  restaurantId: string | null;
  code: string;
  name: string;
  type: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_DELIVERY';
  value: number;
  minOrderMinor: bigint | null;
  maxDiscountMinor: bigint | null;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimitTotal: number | null;
  usageLimitPerCustomer: number | null;
  firstOrderOnly: boolean;
  isActive: boolean;
  createdByUserId: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PromotionRedemptionRow {
  id: string;
  promotionId: string;
  customerId: string;
  customerPhone: string;
  orderId: string | null;
  status: 'RESERVED' | 'CONFIRMED' | 'RELEASED';
  discountMinor: bigint;
  reservedAt: Date;
  expiresAt: Date | null;
  confirmedAt: Date | null;
}

export interface OutboxEventRow {
  id: string;
  eventType: string;
  payload: unknown;
  status: string;
  attempts: number;
  lastError: string | null;
  restaurantId: string | null;
  createdAt: Date;
  processedAt: Date | null;
}

export interface NotificationRow {
  id: string;
  outboxEventId: string;
  type: string;
  category: string;
  recipientType: string;
  recipientId: string;
  channel: string;
  title: string;
  body: string;
  contactAddress: string | null;
  status: string;
  readAt: Date | null;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  providerMessageId: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationPreferenceRow {
  id: string;
  recipientType: string;
  recipientId: string;
  category: string;
  channel: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Simulates a Prisma P2002 unique-constraint-violation error — the shape `isUniqueConstraintViolation` (platform/database/prisma-errors.ts) checks for. */
function prismaUniqueError(target: string[]): Error {
  const error = new Error(
    `Unique constraint failed on the fields: (${target.join(', ')})`,
  ) as Error & {
    code: string;
    meta: { target: string[] };
  };
  error.code = 'P2002';
  error.meta = { target };
  return error;
}

export interface InMemoryPrisma {
  users: UserRow[];
  sessions: SessionRow[];
  otpChallenges: OtpChallengeRow[];
  auditLogs: AuditLogRow[];
  restaurants: RestaurantRow[];
  restaurantStaff: RestaurantStaffRow[];
  restaurantAddresses: RestaurantAddressRow[];
  restaurantBranding: RestaurantBrandingRow[];
  restaurantSettings: RestaurantSettingsRow[];
  staffInvitations: StaffInvitationRow[];
  menuCategories: MenuCategoryRow[];
  menuItems: MenuItemRow[];
  operatingHours: OperatingHoursRow[];
  specialHours: SpecialHoursRow[];
  closurePeriods: ClosurePeriodRow[];
  customers: CustomerRow[];
  carts: CartRow[];
  cartItems: CartItemRow[];
  orders: OrderRow[];
  orderItems: OrderItemRow[];
  orderStatusHistory: OrderStatusHistoryRow[];
  payments: PaymentRow[];
  refunds: RefundRow[];
  webhookEvents: WebhookEventRow[];
  reconciliationIssues: ReconciliationIssueRow[];
  deliveries: DeliveryRow[];
  outboxEvents: OutboxEventRow[];
  notifications: NotificationRow[];
  notificationPreferences: NotificationPreferenceRow[];
  adminUsers: AdminUserRow[];
  promotions: PromotionRow[];
  promotionRedemptions: PromotionRedemptionRow[];
  prisma: PrismaService;
}

export function createInMemoryPrisma(): InMemoryPrisma {
  const users: UserRow[] = [];
  const sessions: SessionRow[] = [];
  const otpChallenges: OtpChallengeRow[] = [];
  const auditLogs: AuditLogRow[] = [];
  const restaurants: RestaurantRow[] = [];
  const restaurantStaff: RestaurantStaffRow[] = [];
  const restaurantAddresses: RestaurantAddressRow[] = [];
  const restaurantBranding: RestaurantBrandingRow[] = [];
  const restaurantSettings: RestaurantSettingsRow[] = [];
  const staffInvitations: StaffInvitationRow[] = [];
  const menuCategories: MenuCategoryRow[] = [];
  const menuItems: MenuItemRow[] = [];
  const operatingHours: OperatingHoursRow[] = [];
  const specialHours: SpecialHoursRow[] = [];
  const closurePeriods: ClosurePeriodRow[] = [];
  const customers: CustomerRow[] = [];
  const carts: CartRow[] = [];
  const cartItems: CartItemRow[] = [];
  const orders: OrderRow[] = [];
  const orderItems: OrderItemRow[] = [];
  const orderStatusHistory: OrderStatusHistoryRow[] = [];
  const payments: PaymentRow[] = [];
  const refunds: RefundRow[] = [];
  const webhookEvents: WebhookEventRow[] = [];
  const reconciliationIssues: ReconciliationIssueRow[] = [];
  const deliveries: DeliveryRow[] = [];
  const outboxEvents: OutboxEventRow[] = [];
  const notifications: NotificationRow[] = [];
  const notificationPreferences: NotificationPreferenceRow[] = [];
  const adminUsers: AdminUserRow[] = [];
  const promotions: PromotionRow[] = [];
  const promotionRedemptions: PromotionRedemptionRow[] = [];

  // Phase 14: real Postgres serializes concurrent claimants against the
  // SAME promotion via `SELECT ... FOR UPDATE`; this fake has no real
  // database engine to provide that. Chaining every interactive
  // `$transaction` callback onto this queue serializes them ALL
  // globally instead — coarser than real Postgres (which only blocks on
  // the specific locked row), but a safe strengthening: every
  // transaction body in this codebase already assumes it runs "as if"
  // isolated, and this makes that literally true rather than an
  // accident of Node's microtask scheduling. Without it,
  // PromotionReservationService's lock-count-insert sequence (and
  // RefundService's/OrderStateService's equivalents) would be genuinely
  // racy under `Promise.all`-driven concurrent test calls — found while
  // building Phase 14's "N+1 concurrent claims on a limit-N coupon
  // yield exactly N" test.
  let transactionQueue: Promise<unknown> = Promise.resolve();

  const user = {
    create: ({ data }: { data: Partial<UserRow> }) => {
      const row: UserRow = {
        id: randomUUID(),
        email: null,
        phone: null,
        passwordHash: null,
        fullName: '',
        status: 'ACTIVE',
        emailVerifiedAt: null,
        phoneVerifiedAt: null,
        mfaSecret: null,
        mfaEnabledAt: null,
        lastLoginAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...omitUndefined(data),
      };
      users.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({ where }: { where: Partial<UserRow> }) => {
      const row =
        users.find((u) => {
          if (where.id !== undefined) return u.id === where.id;
          if (where.email !== undefined) return u.email === where.email;
          if (where.phone !== undefined) return u.phone === where.phone;
          return false;
        }) ?? null;
      return Promise.resolve(row);
    },
    update: ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
      const row = users.find((u) => u.id === where.id);
      if (!row) throw new Error(`user ${where.id} not found`);
      Object.assign(row, omitUndefined(data), { updatedAt: new Date() });
      return Promise.resolve(row);
    },
    /** `GET /admin/users` (Phase 13) — the one platform-wide, non-restaurant-scoped user search this codebase needs. */
    findMany: ({
      where,
      orderBy,
      cursor,
      skip,
      take,
    }: {
      where?: {
        OR?: {
          fullName?: { contains: string; mode?: string };
          email?: { contains: string; mode?: string };
        }[];
      };
      orderBy?: { createdAt: 'asc' | 'desc' };
      cursor?: { id: string };
      skip?: number;
      take?: number;
    }) => {
      let matches = users.filter((u) => {
        if (!where?.OR) return true;
        return where.OR.some((clause) => {
          if (clause.fullName)
            return u.fullName.toLowerCase().includes(clause.fullName.contains.toLowerCase());
          if (clause.email)
            return (u.email ?? '').toLowerCase().includes(clause.email.contains.toLowerCase());
          return false;
        });
      });
      if (orderBy?.createdAt === 'desc') {
        matches = [...matches].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      } else if (orderBy?.createdAt === 'asc') {
        matches = [...matches].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      if (cursor) {
        const cursorIndex = matches.findIndex((u) => u.id === cursor.id);
        matches = cursorIndex === -1 ? [] : matches.slice(cursorIndex + (skip ?? 0));
      }
      if (take !== undefined) matches = matches.slice(0, take);
      return Promise.resolve(matches);
    },
  };

  const session = {
    create: ({ data }: { data: Partial<SessionRow> & { id: string; familyId: string } }) => {
      const row: SessionRow = {
        userAgent: null,
        ipHash: null,
        revokedAt: null,
        revokedReason: null,
        rotatedFromId: null,
        mfaVerifiedAt: null,
        createdAt: new Date(),
        ...omitUndefined(data),
      } as SessionRow;
      sessions.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({ where }: { where: Partial<SessionRow> }) => {
      const row =
        sessions.find((s) => {
          if (where.id !== undefined) return s.id === where.id;
          if (where.refreshTokenHash !== undefined)
            return s.refreshTokenHash === where.refreshTokenHash;
          return false;
        }) ?? null;
      return Promise.resolve(row);
    },
    update: ({ where, data }: { where: { id: string }; data: Partial<SessionRow> }) => {
      const row = sessions.find((s) => s.id === where.id);
      if (!row) throw new Error(`session ${where.id} not found`);
      Object.assign(row, omitUndefined(data));
      return Promise.resolve(row);
    },
    updateMany: ({
      where,
      data,
    }: {
      where: { id?: string; familyId?: string; userId?: string; revokedAt?: null };
      data: Partial<SessionRow>;
    }) => {
      const matches = sessions.filter((s) => {
        if (where.id !== undefined && s.id !== where.id) return false;
        if (where.familyId !== undefined && s.familyId !== where.familyId) return false;
        if (where.userId !== undefined && s.userId !== where.userId) return false;
        if (where.revokedAt === null && s.revokedAt !== null) return false;
        return true;
      });
      for (const row of matches) {
        Object.assign(row, omitUndefined(data));
      }
      return Promise.resolve({ count: matches.length });
    },
  };

  const otpChallenge = {
    create: ({ data }: { data: Partial<OtpChallengeRow> }) => {
      const row: OtpChallengeRow = {
        id: randomUUID(),
        attempts: 0,
        maxAttempts: 5,
        consumedAt: null,
        createdAt: new Date(),
        ...omitUndefined(data),
      } as OtpChallengeRow;
      otpChallenges.push(row);
      return Promise.resolve(row);
    },
    findFirst: ({
      where,
      orderBy,
    }: {
      where: {
        identifier?: string;
        purpose?: string;
        codeHash?: string;
        consumedAt?: null;
        expiresAt?: { gt: Date };
      };
      orderBy?: { createdAt: 'desc' | 'asc' };
    }) => {
      let matches = otpChallenges.filter((c) => {
        if (where.identifier !== undefined && c.identifier !== where.identifier) return false;
        if (where.purpose !== undefined && c.purpose !== where.purpose) return false;
        if (where.codeHash !== undefined && c.codeHash !== where.codeHash) return false;
        if (where.consumedAt === null && c.consumedAt !== null) return false;
        if (where.expiresAt?.gt && c.expiresAt.getTime() <= where.expiresAt.gt.getTime())
          return false;
        return true;
      });
      if (orderBy?.createdAt === 'desc') {
        matches = [...matches].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      return Promise.resolve(matches[0] ?? null);
    },
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: { attempts?: { increment: number }; consumedAt?: Date };
    }) => {
      const row = otpChallenges.find((c) => c.id === where.id);
      if (!row) throw new Error(`otpChallenge ${where.id} not found`);
      if (data.attempts?.increment) row.attempts += data.attempts.increment;
      if (data.consumedAt !== undefined) row.consumedAt = data.consumedAt;
      return Promise.resolve(row);
    },
  };

  const auditLog = {
    create: ({ data }: { data: Partial<AuditLogRow> }) => {
      const row: AuditLogRow = {
        id: randomUUID(),
        actorId: null,
        entityId: null,
        restaurantId: null,
        before: null,
        after: null,
        reason: null,
        correlationId: null,
        ipHash: null,
        createdAt: new Date(),
        ...omitUndefined(data),
      } as AuditLogRow;
      auditLogs.push(row);
      return Promise.resolve(row);
    },
    /**
     * Was an unconditional `() => []` stub — never actually filtered,
     * paginated, or returned real data. That went unnoticed because
     * nothing exercised `AuditService.findByEntity`/`findByActor`/
     * `findByRestaurant` through a real HTTP path with real data until
     * Phase 13's `GET /admin/audit-logs`. A real, previously-latent gap
     * in this test fake, not application code.
     */
    findMany: ({
      where,
      orderBy,
      cursor,
      skip,
      take,
    }: {
      where?: {
        actorType?: string;
        actorId?: string;
        entityType?: string;
        entityId?: string;
        restaurantId?: string;
      };
      orderBy?: { createdAt: 'asc' | 'desc' };
      cursor?: { id: string };
      skip?: number;
      take?: number;
    }) => {
      let matches = auditLogs.filter((a) => {
        if (where?.actorType !== undefined && a.actorType !== where.actorType) return false;
        if (where?.actorId !== undefined && a.actorId !== where.actorId) return false;
        if (where?.entityType !== undefined && a.entityType !== where.entityType) return false;
        if (where?.entityId !== undefined && a.entityId !== where.entityId) return false;
        if (where?.restaurantId !== undefined && a.restaurantId !== where.restaurantId)
          return false;
        return true;
      });
      if (orderBy?.createdAt === 'desc') {
        matches = [...matches].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      } else if (orderBy?.createdAt === 'asc') {
        matches = [...matches].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      if (cursor) {
        const cursorIndex = matches.findIndex((a) => a.id === cursor.id);
        matches = cursorIndex === -1 ? [] : matches.slice(cursorIndex + (skip ?? 0));
      }
      if (take !== undefined) matches = matches.slice(0, take);
      return Promise.resolve(matches);
    },
  };

  type RestaurantStaffWhere = {
    id?: string;
    userId?: string;
    restaurantId?: string;
    role?: string;
    status?: string;
  };

  const matchRestaurantStaff = (where: RestaurantStaffWhere) => (s: RestaurantStaffRow) => {
    if (where.id !== undefined && s.id !== where.id) return false;
    if (where.userId !== undefined && s.userId !== where.userId) return false;
    if (where.restaurantId !== undefined && s.restaurantId !== where.restaurantId) return false;
    if (where.role !== undefined && s.role !== where.role) return false;
    if (where.status !== undefined && s.status !== where.status) return false;
    return true;
  };

  const restaurantStaffTable = {
    create: ({ data }: { data: Partial<RestaurantStaffRow> }) => {
      const row: RestaurantStaffRow = {
        id: randomUUID(),
        status: 'ACTIVE',
        invitedByUserId: null,
        joinedAt: new Date(),
        disabledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...omitUndefined(data),
      } as RestaurantStaffRow;
      restaurantStaff.push(row);
      return Promise.resolve(row);
    },
    findMany: ({
      where,
      orderBy,
      include,
    }: {
      where: RestaurantStaffWhere;
      orderBy?: { joinedAt: 'asc' | 'desc' };
      include?: { restaurant?: boolean; user?: unknown };
    }) => {
      let matches = restaurantStaff.filter(matchRestaurantStaff(where));
      if (orderBy?.joinedAt) {
        const dir = orderBy.joinedAt === 'desc' ? -1 : 1;
        matches = [...matches].sort((a, b) => dir * (a.joinedAt.getTime() - b.joinedAt.getTime()));
      }
      return Promise.resolve(
        matches.map((s) => {
          let row: object = s;
          if (include?.restaurant) {
            row = { ...row, restaurant: restaurants.find((r) => r.id === s.restaurantId) ?? null };
          }
          if (include?.user) {
            const u = users.find((u) => u.id === s.userId);
            row = {
              ...row,
              user: u ? { id: u.id, fullName: u.fullName, email: u.email, phone: u.phone } : null,
            };
          }
          return row;
        }),
      );
    },
    findFirst: ({ where }: { where: RestaurantStaffWhere }) => {
      return Promise.resolve(restaurantStaff.find(matchRestaurantStaff(where)) ?? null);
    },
    count: ({ where }: { where: RestaurantStaffWhere }) => {
      return Promise.resolve(restaurantStaff.filter(matchRestaurantStaff(where)).length);
    },
    findUnique: ({
      where,
    }: {
      where: { userId_restaurantId: { userId: string; restaurantId: string } };
    }) => {
      const { userId, restaurantId } = where.userId_restaurantId;
      const row =
        restaurantStaff.find((s) => s.userId === userId && s.restaurantId === restaurantId) ?? null;
      return Promise.resolve(row);
    },
    updateMany: ({
      where,
      data,
    }: {
      where: RestaurantStaffWhere;
      data: Partial<RestaurantStaffRow>;
    }) => {
      const matches = restaurantStaff.filter(matchRestaurantStaff(where));
      for (const row of matches) {
        Object.assign(row, omitUndefined(data), { updatedAt: new Date() });
      }
      return Promise.resolve({ count: matches.length });
    },
  };

  const restaurantTable = {
    create: ({ data }: { data: Partial<RestaurantRow> }) => {
      const row: RestaurantRow = {
        id: randomUUID(),
        description: null,
        phone: null,
        email: null,
        timezone: 'Asia/Kolkata',
        status: 'DRAFT',
        onboardingStatus: 'NOT_STARTED',
        orderingEnabled: false,
        avgPrepMinutes: null,
        ratingAvg: null,
        ratingCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...omitUndefined(data),
      } as RestaurantRow;
      restaurants.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({
      where,
      include,
    }: {
      where: { id?: string; slug?: string };
      include?: { address?: boolean; branding?: boolean; settings?: boolean };
    }) => {
      const row =
        restaurants.find((r) => {
          if (where.id !== undefined) return r.id === where.id;
          if (where.slug !== undefined) return r.slug === where.slug;
          return false;
        }) ?? null;
      if (!row) return Promise.resolve(null);
      if (!include) return Promise.resolve(row);

      let result: object = row;
      if (include.address) {
        result = {
          ...result,
          address: restaurantAddresses.find((a) => a.restaurantId === row.id) ?? null,
        };
      }
      if (include.branding) {
        result = {
          ...result,
          branding: restaurantBranding.find((b) => b.restaurantId === row.id) ?? null,
        };
      }
      if (include.settings) {
        result = {
          ...result,
          settings: restaurantSettings.find((s) => s.restaurantId === row.id) ?? null,
        };
      }
      return Promise.resolve(result);
    },
    update: ({ where, data }: { where: { id: string }; data: Partial<RestaurantRow> }) => {
      const row = restaurants.find((r) => r.id === where.id);
      if (!row) throw new Error(`restaurant ${where.id} not found`);
      Object.assign(row, omitUndefined(data), { updatedAt: new Date() });
      return Promise.resolve(row);
    },
    count: ({ where }: { where: { slug?: string } }) => {
      return Promise.resolve(
        restaurants.filter((r) => where.slug === undefined || r.slug === where.slug).length,
      );
    },
    /** `AdminOverviewController`'s per-status breakdown (Phase 13) — the one `groupBy` this fake needs to support. */
    groupBy: (_args: { by: ['status']; _count: true }) => {
      const counts = new Map<string, number>();
      for (const r of restaurants) {
        counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
      }
      return Promise.resolve(
        [...counts.entries()].map(([status, count]) => ({ status, _count: count })),
      );
    },
  };

  function createUpsertTable<Row extends { id: string; restaurantId: string }>(
    rows: Row[],
    defaults: Omit<Row, 'id' | 'restaurantId'>,
  ) {
    return {
      findUnique: ({ where }: { where: { restaurantId: string } }) => {
        return Promise.resolve(rows.find((r) => r.restaurantId === where.restaurantId) ?? null);
      },
      create: ({ data }: { data: Partial<Row> & { restaurantId: string } }) => {
        const row = { id: randomUUID(), ...defaults, ...omitUndefined(data) } as Row;
        rows.push(row);
        return Promise.resolve(row);
      },
      upsert: ({
        where,
        create,
        update,
      }: {
        where: { restaurantId: string };
        create: Partial<Row> & { restaurantId: string };
        update: Partial<Row>;
      }) => {
        const existing = rows.find((r) => r.restaurantId === where.restaurantId);
        if (existing) {
          Object.assign(
            existing,
            omitUndefined(update),
            'updatedAt' in existing ? { updatedAt: new Date() } : {},
          );
          return Promise.resolve(existing);
        }
        const row = { id: randomUUID(), ...defaults, ...omitUndefined(create) } as Row;
        rows.push(row);
        return Promise.resolve(row);
      },
    };
  }

  const restaurantAddressTable = createUpsertTable<RestaurantAddressRow>(restaurantAddresses, {
    line2: null,
    locality: null,
    latitude: null,
    longitude: null,
    landmark: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Omit<RestaurantAddressRow, 'id' | 'restaurantId'>);

  const restaurantBrandingTable = createUpsertTable<RestaurantBrandingRow>(restaurantBranding, {
    logoUrl: null,
    coverImageUrl: null,
    themePrimaryColor: null,
    themeAccentColor: null,
    tagline: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const restaurantSettingsTable = createUpsertTable<RestaurantSettingsRow>(restaurantSettings, {
    minOrderAmountMinor: 0n,
    packagingFeeMinor: 0n,
    deliveryFeeMode: 'FLAT',
    deliveryFeeFlatMinor: 0n,
    acceptsOnlinePayment: false,
    autoAcceptOrders: false,
    notificationEmails: [],
    notificationPhones: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  type StaffInvitationWhere = {
    id?: string;
    restaurantId?: string;
    email?: string;
    status?: string;
    tokenHash?: string;
  };
  const matchInvitation = (where: StaffInvitationWhere) => (i: StaffInvitationRow) => {
    if (where.id !== undefined && i.id !== where.id) return false;
    if (where.restaurantId !== undefined && i.restaurantId !== where.restaurantId) return false;
    if (where.email !== undefined && i.email !== where.email) return false;
    if (where.status !== undefined && i.status !== where.status) return false;
    if (where.tokenHash !== undefined && i.tokenHash !== where.tokenHash) return false;
    return true;
  };

  const staffInvitationTable = {
    create: ({ data }: { data: Partial<StaffInvitationRow> }) => {
      const row: StaffInvitationRow = {
        id: randomUUID(),
        status: 'PENDING',
        acceptedAt: null,
        revokedAt: null,
        createdAt: new Date(),
        ...omitUndefined(data),
      } as StaffInvitationRow;
      staffInvitations.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({ where }: { where: { tokenHash: string } }) => {
      return Promise.resolve(staffInvitations.find((i) => i.tokenHash === where.tokenHash) ?? null);
    },
    findFirst: ({ where }: { where: StaffInvitationWhere }) => {
      return Promise.resolve(staffInvitations.find(matchInvitation(where)) ?? null);
    },
    findMany: ({
      where,
      orderBy,
    }: {
      where: StaffInvitationWhere;
      orderBy?: { createdAt: 'asc' | 'desc' };
    }) => {
      let matches = staffInvitations.filter(matchInvitation(where));
      if (orderBy?.createdAt === 'desc') {
        matches = [...matches].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      return Promise.resolve(matches);
    },
    update: ({ where, data }: { where: { id: string }; data: Partial<StaffInvitationRow> }) => {
      const row = staffInvitations.find((i) => i.id === where.id);
      if (!row) throw new Error(`staffInvitation ${where.id} not found`);
      Object.assign(row, omitUndefined(data));
      return Promise.resolve(row);
    },
    updateMany: ({
      where,
      data,
    }: {
      where: StaffInvitationWhere;
      data: Partial<StaffInvitationRow>;
    }) => {
      const matches = staffInvitations.filter(matchInvitation(where));
      for (const row of matches) {
        Object.assign(row, omitUndefined(data));
      }
      return Promise.resolve({ count: matches.length });
    },
  };

  type MenuCategoryWhere = {
    id?: string;
    restaurantId?: string;
    archivedAt?: null;
    name?: { equals: string; mode?: string };
  };
  const matchMenuCategory = (where: MenuCategoryWhere) => (c: MenuCategoryRow) => {
    if (where.id !== undefined && c.id !== where.id) return false;
    if (where.restaurantId !== undefined && c.restaurantId !== where.restaurantId) return false;
    if (where.archivedAt === null && c.archivedAt !== null) return false;
    if (where.name !== undefined) {
      const matches =
        where.name.mode === 'insensitive'
          ? c.name.toLowerCase() === where.name.equals.toLowerCase()
          : c.name === where.name.equals;
      if (!matches) return false;
    }
    return true;
  };

  const menuCategoryTable = {
    create: ({ data }: { data: Partial<MenuCategoryRow> }) => {
      const row: MenuCategoryRow = {
        id: randomUUID(),
        description: null,
        displayOrder: 0,
        isActive: true,
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...omitUndefined(data),
      } as MenuCategoryRow;
      menuCategories.push(row);
      return Promise.resolve(row);
    },
    findFirst: ({ where }: { where: MenuCategoryWhere }) => {
      return Promise.resolve(menuCategories.find(matchMenuCategory(where)) ?? null);
    },
    findMany: ({
      where,
      orderBy,
    }: {
      where: MenuCategoryWhere;
      orderBy?: { displayOrder: 'asc' | 'desc' };
    }) => {
      let matches = menuCategories.filter(matchMenuCategory(where));
      if (orderBy?.displayOrder) {
        const dir = orderBy.displayOrder === 'desc' ? -1 : 1;
        matches = [...matches].sort((a, b) => dir * (a.displayOrder - b.displayOrder));
      }
      return Promise.resolve(matches);
    },
    updateMany: ({ where, data }: { where: MenuCategoryWhere; data: Partial<MenuCategoryRow> }) => {
      const matches = menuCategories.filter(matchMenuCategory(where));
      for (const row of matches) {
        Object.assign(row, omitUndefined(data), { updatedAt: new Date() });
      }
      return Promise.resolve({ count: matches.length });
    },
  };

  type MenuItemWhere = {
    id?: string | { in: string[] };
    restaurantId?: string;
    categoryId?: string;
    archivedAt?: null;
  };
  const matchMenuItem = (where: MenuItemWhere) => (i: MenuItemRow) => {
    if (where.id !== undefined) {
      const matchesId =
        typeof where.id === 'string' ? i.id === where.id : where.id.in.includes(i.id);
      if (!matchesId) return false;
    }
    if (where.restaurantId !== undefined && i.restaurantId !== where.restaurantId) return false;
    if (where.categoryId !== undefined && i.categoryId !== where.categoryId) return false;
    if (where.archivedAt === null && i.archivedAt !== null) return false;
    return true;
  };

  const menuItemTable = {
    create: ({ data }: { data: Partial<MenuItemRow> }) => {
      const row: MenuItemRow = {
        id: randomUUID(),
        description: null,
        currency: 'INR',
        imageUrl: null,
        isAvailable: true,
        isActive: true,
        displayOrder: 0,
        dietaryTag: 'UNKNOWN',
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...omitUndefined(data),
      } as MenuItemRow;
      menuItems.push(row);
      return Promise.resolve(row);
    },
    findFirst: ({ where }: { where: MenuItemWhere }) => {
      return Promise.resolve(menuItems.find(matchMenuItem(where)) ?? null);
    },
    findMany: ({
      where,
      orderBy,
    }: {
      where: MenuItemWhere;
      orderBy?: { displayOrder: 'asc' | 'desc' };
    }) => {
      let matches = menuItems.filter(matchMenuItem(where));
      if (orderBy?.displayOrder) {
        const dir = orderBy.displayOrder === 'desc' ? -1 : 1;
        matches = [...matches].sort((a, b) => dir * (a.displayOrder - b.displayOrder));
      }
      return Promise.resolve(matches);
    },
    updateMany: ({ where, data }: { where: MenuItemWhere; data: Partial<MenuItemRow> }) => {
      const matches = menuItems.filter(matchMenuItem(where));
      for (const row of matches) {
        Object.assign(row, omitUndefined(data), { updatedAt: new Date() });
      }
      return Promise.resolve({ count: matches.length });
    },
    count: ({ where }: { where: MenuItemWhere }) => {
      return Promise.resolve(menuItems.filter(matchMenuItem(where)).length);
    },
  };

  type OperatingHoursWhere = { restaurantId?: string; dayOfWeek?: number };
  const matchOperatingHours = (where: OperatingHoursWhere) => (row: OperatingHoursRow) => {
    if (where.restaurantId !== undefined && row.restaurantId !== where.restaurantId) return false;
    if (where.dayOfWeek !== undefined && row.dayOfWeek !== where.dayOfWeek) return false;
    return true;
  };

  const operatingHoursTable = {
    create: ({ data }: { data: Partial<OperatingHoursRow> }) => {
      const row: OperatingHoursRow = {
        id: randomUUID(),
        isClosed: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...omitUndefined(data),
      } as OperatingHoursRow;
      operatingHours.push(row);
      return Promise.resolve(row);
    },
    findMany: ({
      where,
      orderBy,
    }: {
      where: OperatingHoursWhere;
      orderBy?: { dayOfWeek: 'asc' | 'desc' }[] | { dayOfWeek: 'asc' | 'desc' };
    }) => {
      let matches = operatingHours.filter(matchOperatingHours(where));
      const primary = Array.isArray(orderBy) ? orderBy[0] : orderBy;
      if (primary?.dayOfWeek) {
        const dir = primary.dayOfWeek === 'desc' ? -1 : 1;
        matches = [...matches].sort((a, b) => dir * (a.dayOfWeek - b.dayOfWeek));
      }
      return Promise.resolve(matches);
    },
    deleteMany: ({ where }: { where: OperatingHoursWhere }) => {
      const keep = operatingHours.filter((row) => !matchOperatingHours(where)(row));
      const removed = operatingHours.length - keep.length;
      operatingHours.length = 0;
      operatingHours.push(...keep);
      return Promise.resolve({ count: removed });
    },
  };

  type SpecialHoursWhere = { restaurantId?: string; date?: Date };
  const specialHoursTable = {
    findFirst: ({ where }: { where: SpecialHoursWhere }) => {
      const row =
        specialHours.find((s) => {
          if (where.restaurantId !== undefined && s.restaurantId !== where.restaurantId)
            return false;
          if (where.date !== undefined && s.date.getTime() !== where.date.getTime()) return false;
          return true;
        }) ?? null;
      return Promise.resolve(row);
    },
  };

  type ClosurePeriodWhere = {
    id?: string;
    restaurantId?: string;
    startsAt?: { lte: Date };
    OR?: ({ endsAt: null } | { endsAt: { gt: Date } })[];
  };
  const matchClosurePeriod = (where: ClosurePeriodWhere) => (row: ClosurePeriodRow) => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.restaurantId !== undefined && row.restaurantId !== where.restaurantId) return false;
    if (where.startsAt?.lte && row.startsAt.getTime() > where.startsAt.lte.getTime()) return false;
    if (where.OR) {
      const matchesOr = where.OR.some((clause) => {
        if (clause.endsAt === null) return row.endsAt === null;
        return row.endsAt !== null && row.endsAt.getTime() > clause.endsAt.gt.getTime();
      });
      if (!matchesOr) return false;
    }
    return true;
  };

  const closurePeriodTable = {
    create: ({ data }: { data: Partial<ClosurePeriodRow> }) => {
      const row: ClosurePeriodRow = {
        id: randomUUID(),
        endsAt: null,
        reason: null,
        createdAt: new Date(),
        ...omitUndefined(data),
      } as ClosurePeriodRow;
      closurePeriods.push(row);
      return Promise.resolve(row);
    },
    findFirst: ({ where }: { where: ClosurePeriodWhere }) => {
      return Promise.resolve(closurePeriods.find(matchClosurePeriod(where)) ?? null);
    },
    findMany: ({
      where,
      orderBy,
    }: {
      where: ClosurePeriodWhere;
      orderBy?: { startsAt: 'asc' | 'desc' };
    }) => {
      let matches = closurePeriods.filter(matchClosurePeriod(where));
      if (orderBy?.startsAt) {
        const dir = orderBy.startsAt === 'desc' ? -1 : 1;
        matches = [...matches].sort((a, b) => dir * (a.startsAt.getTime() - b.startsAt.getTime()));
      }
      return Promise.resolve(matches);
    },
    updateMany: ({
      where,
      data,
    }: {
      where: ClosurePeriodWhere;
      data: Partial<ClosurePeriodRow>;
    }) => {
      const matches = closurePeriods.filter(matchClosurePeriod(where));
      for (const row of matches) {
        Object.assign(row, omitUndefined(data));
      }
      return Promise.resolve({ count: matches.length });
    },
  };

  const customerTable = {
    create: ({ data }: { data: Partial<CustomerRow> }) => {
      const row: CustomerRow = {
        id: randomUUID(),
        userId: null,
        email: null,
        status: 'ACTIVE',
        marketingConsentAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...omitUndefined(data),
      } as CustomerRow;
      customers.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({ where }: { where: { id: string } }) => {
      return Promise.resolve(customers.find((c) => c.id === where.id) ?? null);
    },
  };

  interface CartCreateData {
    restaurantId: string;
    guestTokenHash: string;
    status?: string;
    expiresAt: Date;
    items?: { create: { menuItemId: string; quantity: number; unitPriceMinorAtAdd: bigint }[] };
  }

  const cartTable = {
    create: ({ data }: { data: CartCreateData }) => {
      const row: CartRow = {
        id: randomUUID(),
        restaurantId: data.restaurantId,
        customerId: null,
        guestTokenHash: data.guestTokenHash,
        status: (data.status as CartRow['status']) ?? 'OPEN',
        expiresAt: data.expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      carts.push(row);
      const createdItems: CartItemRow[] = (data.items?.create ?? []).map((item) => {
        const itemRow: CartItemRow = {
          id: randomUUID(),
          cartId: row.id,
          menuItemId: item.menuItemId,
          quantity: item.quantity,
          unitPriceMinorAtAdd: item.unitPriceMinorAtAdd,
          createdAt: new Date(),
        };
        cartItems.push(itemRow);
        return itemRow;
      });
      return Promise.resolve({ ...row, items: createdItems });
    },
    findUnique: ({ where, include }: { where: { id: string }; include?: { items?: boolean } }) => {
      const row = carts.find((c) => c.id === where.id) ?? null;
      if (!row) return Promise.resolve(null);
      if (!include?.items) return Promise.resolve(row);
      return Promise.resolve({ ...row, items: cartItems.filter((i) => i.cartId === row.id) });
    },
    update: ({ where, data }: { where: { id: string }; data: Partial<CartRow> }) => {
      const row = carts.find((c) => c.id === where.id);
      if (!row) throw new Error(`cart ${where.id} not found`);
      Object.assign(row, omitUndefined(data), { updatedAt: new Date() });
      return Promise.resolve(row);
    },
  };

  interface OrderNestedItemCreate {
    menuItemId: string;
    nameSnapshot: string;
    descriptionSnapshot?: string;
    unitPriceMinorSnapshot: bigint;
    quantity: number;
    lineTotalMinor: bigint;
  }
  interface OrderNestedHistoryCreate {
    fromStatus?: string | null;
    toStatus: string;
    actorType: string;
    actorId?: string;
    reason?: string;
  }
  interface OrderNestedPaymentCreate {
    provider: string;
    status: string;
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
  }
  interface OrderNestedPromotionRedemptionCreate {
    promotionId: string;
    customerId: string;
    customerPhone: string;
    status: string;
    discountMinor: bigint;
  }
  interface OrderCreateData {
    orderNumber: string;
    restaurantId: string;
    customerId: string;
    status: string;
    customerName: string;
    customerPhone: string;
    deliveryAddress: unknown;
    itemsSubtotalMinor: bigint;
    packagingFeeMinor: bigint;
    deliveryFeeMinor: bigint;
    platformFeeMinor: bigint;
    taxMinor: bigint;
    discountMinor: bigint;
    loyaltyDiscountMinor: bigint;
    payableTotalMinor: bigint;
    pricingBreakdown: unknown;
    promotionId?: string;
    couponCode?: string;
    idempotencyKey: string;
    accessTokenHash: string;
    items?: { create: OrderNestedItemCreate[] };
    history?: { create: OrderNestedHistoryCreate[] };
    payments?: { create: OrderNestedPaymentCreate[] };
    promotionRedemptions?: { create: OrderNestedPromotionRedemptionCreate[] };
  }
  type OrderWhere =
    | { id: string }
    | { orderNumber: string }
    | { restaurantId_idempotencyKey: { restaurantId: string; idempotencyKey: string } };

  function findOrder(where: OrderWhere): OrderRow | undefined {
    if ('id' in where) return orders.find((o) => o.id === where.id);
    if ('orderNumber' in where) return orders.find((o) => o.orderNumber === where.orderNumber);
    const { restaurantId, idempotencyKey } = where.restaurantId_idempotencyKey;
    return orders.find(
      (o) => o.restaurantId === restaurantId && o.idempotencyKey === idempotencyKey,
    );
  }

  interface OrderListWhere {
    id?: string;
    restaurantId?: string;
    orderNumber?: string;
    customerPhone?: string;
    status?: string | { in: string[] };
    createdAt?: { lt?: Date; gte?: Date };
  }

  /** Backs the expiry scheduler's scan (`status`, `createdAt.lt`), Phase 10's restaurant order queue/detail (`restaurantId`, `status.in`, `id`), Phase 13's admin cross-tenant search (`orderNumber`, `createdAt.gte` for "today"), and Phase 14's first-order-only eligibility check (`customerPhone`, `status`, optional `restaurantId`). */
  function matchOrderList(where: OrderListWhere) {
    return (o: OrderRow) => {
      if (where.id !== undefined && o.id !== where.id) return false;
      if (where.restaurantId !== undefined && o.restaurantId !== where.restaurantId) return false;
      if (where.orderNumber !== undefined && o.orderNumber !== where.orderNumber) return false;
      if (where.customerPhone !== undefined && o.customerPhone !== where.customerPhone)
        return false;
      if (where.createdAt?.gte && o.createdAt.getTime() < where.createdAt.gte.getTime())
        return false;
      if (where.status !== undefined) {
        const matchesStatus =
          typeof where.status === 'string'
            ? o.status === where.status
            : where.status.in.includes(o.status);
        if (!matchesStatus) return false;
      }
      if (where.createdAt?.lt && o.createdAt.getTime() >= where.createdAt.lt.getTime())
        return false;
      return true;
    };
  }

  type OrderInclude = {
    items?: boolean;
    history?: unknown;
    payments?: unknown;
    delivery?: boolean;
  };

  /** Shared by `findUnique` and `findFirst` — both need the same items/history/payments/delivery population, real Prisma's `include` behavior for a single-row lookup. */
  function withOrderRelations(
    row: OrderRow,
    include: OrderInclude,
  ): OrderRow & {
    items?: OrderItemRow[];
    history?: OrderStatusHistoryRow[];
    payments?: PaymentRow[];
    delivery?: DeliveryRow | null;
  } {
    const result: OrderRow & {
      items?: OrderItemRow[];
      history?: OrderStatusHistoryRow[];
      payments?: PaymentRow[];
      delivery?: DeliveryRow | null;
    } = { ...row };
    if (include.items) {
      result.items = orderItems.filter((i) => i.orderId === row.id);
    }
    if (include.history) {
      result.history = orderStatusHistory
        .filter((h) => h.orderId === row.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }
    if (include.payments) {
      result.payments = payments
        .filter((p) => p.orderId === row.id)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }
    if (include.delivery) {
      result.delivery = deliveries.find((d) => d.orderId === row.id) ?? null;
    }
    return result;
  }

  const orderTable = {
    create: ({ data, include }: { data: OrderCreateData; include?: { payments?: boolean } }) => {
      if (orders.some((o) => o.orderNumber === data.orderNumber)) {
        throw prismaUniqueError(['orderNumber']);
      }
      if (
        orders.some(
          (o) => o.restaurantId === data.restaurantId && o.idempotencyKey === data.idempotencyKey,
        )
      ) {
        throw prismaUniqueError(['restaurantId', 'idempotencyKey']);
      }

      const row: OrderRow = {
        id: randomUUID(),
        orderNumber: data.orderNumber,
        restaurantId: data.restaurantId,
        customerId: data.customerId,
        status: data.status,
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        deliveryAddress: data.deliveryAddress,
        itemsSubtotalMinor: data.itemsSubtotalMinor,
        packagingFeeMinor: data.packagingFeeMinor,
        deliveryFeeMinor: data.deliveryFeeMinor,
        platformFeeMinor: data.platformFeeMinor,
        taxMinor: data.taxMinor,
        discountMinor: data.discountMinor,
        loyaltyDiscountMinor: data.loyaltyDiscountMinor,
        payableTotalMinor: data.payableTotalMinor,
        currency: 'INR',
        pricingBreakdown: data.pricingBreakdown,
        promotionId: data.promotionId ?? null,
        couponCode: data.couponCode ?? null,
        appliedLoyaltyPoints: 0,
        idempotencyKey: data.idempotencyKey,
        accessTokenHash: data.accessTokenHash,
        placedAt: null,
        acceptedAt: null,
        readyAt: null,
        deliveredAt: null,
        cancelledAt: null,
        rejectionReason: null,
        cancellationReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      orders.push(row);

      for (const item of data.items?.create ?? []) {
        orderItems.push({
          id: randomUUID(),
          orderId: row.id,
          menuItemId: item.menuItemId,
          nameSnapshot: item.nameSnapshot,
          descriptionSnapshot: item.descriptionSnapshot ?? null,
          unitPriceMinorSnapshot: item.unitPriceMinorSnapshot,
          quantity: item.quantity,
          lineTotalMinor: item.lineTotalMinor,
          createdAt: new Date(),
        });
      }
      for (const entry of data.history?.create ?? []) {
        orderStatusHistory.push({
          id: randomUUID(),
          orderId: row.id,
          fromStatus: entry.fromStatus ?? null,
          toStatus: entry.toStatus,
          actorType: entry.actorType,
          actorId: entry.actorId ?? null,
          reason: entry.reason ?? null,
          metadata: null,
          createdAt: new Date(),
        });
      }
      const createdPayments: PaymentRow[] = (data.payments?.create ?? []).map((p) => {
        const paymentRow: PaymentRow = {
          id: randomUUID(),
          orderId: row.id,
          provider: p.provider,
          providerOrderId: null,
          providerPaymentId: null,
          status: p.status,
          amountMinor: p.amountMinor,
          capturedMinor: 0n,
          refundedMinor: 0n,
          currency: p.currency,
          method: null,
          failureCode: null,
          failureMessage: null,
          idempotencyKey: p.idempotencyKey,
          reconciliationStatus: 'OK',
          authorizedAt: null,
          capturedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        payments.push(paymentRow);
        return paymentRow;
      });

      for (const redemption of data.promotionRedemptions?.create ?? []) {
        promotionRedemptions.push({
          id: randomUUID(),
          promotionId: redemption.promotionId,
          customerId: redemption.customerId,
          customerPhone: redemption.customerPhone,
          orderId: row.id,
          status: redemption.status as PromotionRedemptionRow['status'],
          discountMinor: redemption.discountMinor,
          reservedAt: new Date(),
          expiresAt: null,
          confirmedAt: null,
        });
      }

      const result: OrderRow & { payments?: PaymentRow[] } = { ...row };
      if (include?.payments) result.payments = createdPayments;
      return Promise.resolve(result);
    },
    findUnique: ({ where, include }: { where: OrderWhere; include?: OrderInclude }) => {
      const row = findOrder(where);
      if (!row) return Promise.resolve(null);
      return Promise.resolve(include ? withOrderRelations(row, include) : row);
    },
    update: ({ where, data }: { where: { id: string }; data: Partial<OrderRow> }) => {
      const row = orders.find((o) => o.id === where.id);
      if (!row) throw new Error(`order ${where.id} not found`);
      Object.assign(row, omitUndefined(data), { updatedAt: new Date() });
      return Promise.resolve(row);
    },
    findMany: ({
      where,
      orderBy,
      cursor,
      skip,
      take,
    }: {
      where: OrderListWhere;
      orderBy?: { createdAt: 'asc' | 'desc' };
      cursor?: { id: string };
      skip?: number;
      take?: number;
    }) => {
      let matches = orders.filter(matchOrderList(where));
      if (orderBy?.createdAt === 'desc') {
        matches = [...matches].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      } else if (orderBy?.createdAt === 'asc') {
        matches = [...matches].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      if (cursor) {
        const cursorIndex = matches.findIndex((o) => o.id === cursor.id);
        matches = cursorIndex === -1 ? [] : matches.slice(cursorIndex + (skip ?? 0));
      }
      if (take !== undefined) matches = matches.slice(0, take);
      return Promise.resolve(matches);
    },
    findFirst: ({ where, include }: { where: OrderListWhere; include?: OrderInclude }) => {
      const row = orders.find(matchOrderList(where)) ?? null;
      if (!row) return Promise.resolve(null);
      return Promise.resolve(include ? withOrderRelations(row, include) : row);
    },
    count: ({ where }: { where: OrderListWhere }) => {
      return Promise.resolve(orders.filter(matchOrderList(where)).length);
    },
  };

  const orderStatusHistoryTable = {
    create: ({ data }: { data: OrderNestedHistoryCreate & { orderId: string } }) => {
      const row: OrderStatusHistoryRow = {
        id: randomUUID(),
        orderId: data.orderId,
        fromStatus: data.fromStatus ?? null,
        toStatus: data.toStatus,
        actorType: data.actorType,
        actorId: data.actorId ?? null,
        reason: data.reason ?? null,
        metadata: null,
        createdAt: new Date(),
      };
      orderStatusHistory.push(row);
      return Promise.resolve(row);
    },
  };

  type PaymentWhere = {
    id?: string;
    orderId?: string;
    provider?: string;
    providerPaymentId?: string;
    providerOrderId?: string;
    idempotencyKey?: string;
  };
  const matchPayment = (where: PaymentWhere) => (p: PaymentRow) => {
    if (where.id !== undefined && p.id !== where.id) return false;
    if (where.orderId !== undefined && p.orderId !== where.orderId) return false;
    if (where.provider !== undefined && p.provider !== where.provider) return false;
    if (where.providerPaymentId !== undefined && p.providerPaymentId !== where.providerPaymentId)
      return false;
    if (where.providerOrderId !== undefined && p.providerOrderId !== where.providerOrderId)
      return false;
    if (where.idempotencyKey !== undefined && p.idempotencyKey !== where.idempotencyKey)
      return false;
    return true;
  };

  const paymentTable = {
    create: ({
      data,
    }: {
      data: {
        orderId: string;
        provider: string;
        providerOrderId?: string;
        status: string;
        amountMinor: bigint;
        currency: string;
        idempotencyKey: string;
      };
    }) => {
      if (payments.some((p) => p.idempotencyKey === data.idempotencyKey)) {
        throw prismaUniqueError(['idempotencyKey']);
      }
      const row: PaymentRow = {
        id: randomUUID(),
        orderId: data.orderId,
        provider: data.provider,
        providerOrderId: data.providerOrderId ?? null,
        providerPaymentId: null,
        status: data.status,
        amountMinor: data.amountMinor,
        capturedMinor: 0n,
        refundedMinor: 0n,
        currency: data.currency,
        method: null,
        failureCode: null,
        failureMessage: null,
        idempotencyKey: data.idempotencyKey,
        reconciliationStatus: 'OK',
        authorizedAt: null,
        capturedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      payments.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({ where }: { where: { id: string } }) => {
      return Promise.resolve(payments.find((p) => p.id === where.id) ?? null);
    },
    findFirst: ({
      where,
      orderBy,
    }: {
      where: PaymentWhere;
      orderBy?: { createdAt: 'asc' | 'desc' };
    }) => {
      let matches = payments.filter(matchPayment(where));
      if (orderBy?.createdAt === 'desc') {
        matches = [...matches].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      return Promise.resolve(matches[0] ?? null);
    },
    findMany: ({
      where,
      orderBy,
      take,
    }: {
      where: PaymentWhere;
      orderBy?: { createdAt: 'asc' | 'desc' };
      take?: number;
    }) => {
      let matches = payments.filter(matchPayment(where));
      if (orderBy?.createdAt === 'desc') {
        matches = [...matches].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      if (take !== undefined) matches = matches.slice(0, take);
      return Promise.resolve(matches);
    },
    update: ({ where, data }: { where: { id: string }; data: Partial<PaymentRow> }) => {
      const row = payments.find((p) => p.id === where.id);
      if (!row) throw new Error(`payment ${where.id} not found`);
      Object.assign(row, omitUndefined(data), { updatedAt: new Date() });
      return Promise.resolve(row);
    },
  };

  type RefundWhere = { paymentId?: string; idempotencyKey?: string; status?: { not: string } };
  const matchRefund = (where: RefundWhere) => (r: RefundRow) => {
    if (where.paymentId !== undefined && r.paymentId !== where.paymentId) return false;
    if (where.idempotencyKey !== undefined && r.idempotencyKey !== where.idempotencyKey)
      return false;
    if (where.status?.not !== undefined && r.status === where.status.not) return false;
    return true;
  };

  const refundTable = {
    create: ({
      data,
    }: {
      data: {
        paymentId: string;
        orderId: string;
        amountMinor: bigint;
        reason: string;
        status?: string;
        initiatedByActorType: string;
        initiatedByActorId?: string;
        idempotencyKey: string;
      };
    }) => {
      if (
        refunds.some(
          (r) => r.paymentId === data.paymentId && r.idempotencyKey === data.idempotencyKey,
        )
      ) {
        throw prismaUniqueError(['paymentId', 'idempotencyKey']);
      }
      const row: RefundRow = {
        id: randomUUID(),
        paymentId: data.paymentId,
        orderId: data.orderId,
        amountMinor: data.amountMinor,
        reason: data.reason,
        status: data.status ?? 'REQUESTED',
        providerRefundId: null,
        initiatedByActorType: data.initiatedByActorType,
        initiatedByActorId: data.initiatedByActorId ?? null,
        idempotencyKey: data.idempotencyKey,
        completedAt: null,
        failureReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      refunds.push(row);
      return Promise.resolve(row);
    },
    findFirst: ({ where }: { where: RefundWhere }) => {
      return Promise.resolve(refunds.find(matchRefund(where)) ?? null);
    },
    findMany: ({ where }: { where: RefundWhere }) => {
      return Promise.resolve(refunds.filter(matchRefund(where)));
    },
    update: ({ where, data }: { where: { id: string }; data: Partial<RefundRow> }) => {
      const row = refunds.find((r) => r.id === where.id);
      if (!row) throw new Error(`refund ${where.id} not found`);
      Object.assign(row, omitUndefined(data), { updatedAt: new Date() });
      return Promise.resolve(row);
    },
  };

  const webhookEventTable = {
    create: ({
      data,
    }: {
      data: {
        provider: string;
        providerEventId: string;
        eventType: string;
        signatureValid: boolean;
        payload: unknown;
      };
    }) => {
      if (
        webhookEvents.some(
          (w) => w.provider === data.provider && w.providerEventId === data.providerEventId,
        )
      ) {
        throw prismaUniqueError(['provider', 'providerEventId']);
      }
      const row: WebhookEventRow = {
        id: randomUUID(),
        provider: data.provider,
        providerEventId: data.providerEventId,
        eventType: data.eventType,
        signatureValid: data.signatureValid,
        payload: data.payload,
        status: 'RECEIVED',
        attempts: 0,
        lastError: null,
        receivedAt: new Date(),
        processedAt: null,
      };
      webhookEvents.push(row);
      return Promise.resolve(row);
    },
    findMany: ({
      where,
      orderBy,
      take,
    }: {
      where: { status: string };
      orderBy?: { receivedAt: 'asc' | 'desc' };
      take?: number;
    }) => {
      let matches = webhookEvents.filter((w) => w.status === where.status);
      if (orderBy?.receivedAt === 'asc') {
        matches = [...matches].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
      }
      if (take !== undefined) matches = matches.slice(0, take);
      return Promise.resolve(matches);
    },
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: Omit<Partial<WebhookEventRow>, 'attempts'> & { attempts?: { increment: number } };
    }) => {
      const row = webhookEvents.find((w) => w.id === where.id);
      if (!row) throw new Error(`webhookEvent ${where.id} not found`);
      if (data.attempts) {
        row.attempts += data.attempts.increment;
      }
      const { attempts: _attempts, ...rest } = data;
      Object.assign(row, omitUndefined(rest));
      return Promise.resolve(row);
    },
  };

  const reconciliationIssueTable = {
    create: ({
      data,
    }: {
      data: {
        entityType: string;
        entityId: string;
        issueType: string;
        expected?: string;
        actual?: string;
        severity: string;
      };
    }) => {
      const row: ReconciliationIssueRow = {
        id: randomUUID(),
        entityType: data.entityType,
        entityId: data.entityId,
        issueType: data.issueType,
        expected: data.expected ?? null,
        actual: data.actual ?? null,
        severity: data.severity,
        status: 'OPEN',
        resolutionNote: null,
        resolvedBy: null,
        detectedAt: new Date(),
      };
      reconciliationIssues.push(row);
      return Promise.resolve(row);
    },
    findMany: ({
      where,
      orderBy,
    }: {
      where: { status: string };
      orderBy?: { detectedAt: 'asc' | 'desc' };
    }) => {
      let matches = reconciliationIssues.filter((r) => r.status === where.status);
      if (orderBy?.detectedAt === 'desc') {
        matches = [...matches].sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime());
      }
      return Promise.resolve(matches);
    },
  };

  const outboxEventTable = {
    create: ({
      data,
    }: {
      data: { eventType: string; payload: unknown; restaurantId?: string };
    }) => {
      const row: OutboxEventRow = {
        id: randomUUID(),
        eventType: data.eventType,
        payload: data.payload,
        status: 'PENDING',
        attempts: 0,
        lastError: null,
        restaurantId: data.restaurantId ?? null,
        createdAt: new Date(),
        processedAt: null,
      };
      outboxEvents.push(row);
      return Promise.resolve(row);
    },
    findMany: ({
      where,
      orderBy,
      take,
    }: {
      where: { status?: string; restaurantId?: string; id?: { gt: string } };
      orderBy?: { createdAt?: 'asc' | 'desc'; id?: 'asc' | 'desc' };
      take?: number;
    }) => {
      // `id` here is a plain `randomUUID()` (v4) in this fake, not a
      // real time-ordered UUIDv7 the way production ids are — a
      // lexicographic `id > cursor` comparison would be pure chance.
      // Array insertion order (outboxEvents.push in OutboxRepository.create)
      // IS creation order, so an `id: { gt }` cursor is resolved by
      // position in this array instead, the same substitution the
      // order-cursor pagination above already relies on.
      let pool = outboxEvents;
      if (where.id?.gt !== undefined) {
        const afterIndex = outboxEvents.findIndex((o) => o.id === where.id!.gt);
        pool = afterIndex === -1 ? outboxEvents : outboxEvents.slice(afterIndex + 1);
      }
      let matches = pool.filter((o) => {
        if (where.status !== undefined && o.status !== where.status) return false;
        if (where.restaurantId !== undefined && o.restaurantId !== where.restaurantId) return false;
        return true;
      });
      if (orderBy?.createdAt === 'desc') {
        matches = [...matches].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      } else if (orderBy?.createdAt === 'asc') {
        matches = [...matches].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      if (take !== undefined) matches = matches.slice(0, take);
      return Promise.resolve(matches);
    },
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: Omit<Partial<OutboxEventRow>, 'attempts'> & { attempts?: { increment: number } };
    }) => {
      const row = outboxEvents.find((o) => o.id === where.id);
      if (!row) throw new Error(`outboxEvent ${where.id} not found`);
      if (data.attempts) {
        row.attempts += data.attempts.increment;
      }
      const { attempts: _attempts, ...rest } = data;
      Object.assign(row, omitUndefined(rest));
      return Promise.resolve(row);
    },
  };

  type DeliveryWhere = { orderId: string } | { provider: string; providerDeliveryId: string };

  function findDelivery(where: DeliveryWhere): DeliveryRow | undefined {
    if ('orderId' in where) return deliveries.find((d) => d.orderId === where.orderId);
    return deliveries.find(
      (d) => d.provider === where.provider && d.providerDeliveryId === where.providerDeliveryId,
    );
  }

  const deliveryTable = {
    create: ({
      data,
    }: {
      data: {
        orderId: string;
        provider: string;
        status: string;
        pickupAddress: unknown;
        dropoffAddress: unknown;
        idempotencyKey: string;
      };
    }) => {
      if (deliveries.some((d) => d.orderId === data.orderId)) {
        throw prismaUniqueError(['orderId']);
      }
      const row: DeliveryRow = {
        id: randomUUID(),
        orderId: data.orderId,
        provider: data.provider,
        providerDeliveryId: null,
        status: data.status,
        pickupAddress: data.pickupAddress,
        dropoffAddress: data.dropoffAddress,
        courierName: null,
        courierPhone: null,
        trackingUrl: null,
        quotedFeeMinor: null,
        actualFeeMinor: null,
        idempotencyKey: data.idempotencyKey,
        attemptCount: 0,
        estimatedPickupAt: null,
        estimatedDeliveryAt: null,
        pickedUpAt: null,
        deliveredAt: null,
        cancellationReason: null,
        failureReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      deliveries.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({ where }: { where: { orderId: string } }) => {
      return Promise.resolve(findDelivery(where) ?? null);
    },
    findFirst: ({ where }: { where: DeliveryWhere }) => {
      return Promise.resolve(findDelivery(where) ?? null);
    },
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: Omit<Partial<DeliveryRow>, 'attemptCount'> & { attemptCount?: { increment: number } };
    }) => {
      const row = deliveries.find((d) => d.id === where.id);
      if (!row) throw new Error(`delivery ${where.id} not found`);
      if (data.providerDeliveryId !== undefined && data.providerDeliveryId !== null) {
        const clash = deliveries.some(
          (d) =>
            d.id !== row.id &&
            d.provider === row.provider &&
            d.providerDeliveryId === data.providerDeliveryId,
        );
        if (clash) throw prismaUniqueError(['provider', 'providerDeliveryId']);
      }
      if (data.attemptCount) {
        row.attemptCount += data.attemptCount.increment;
      }
      const { attemptCount: _attemptCount, ...rest } = data;
      Object.assign(row, omitUndefined(rest), { updatedAt: new Date() });
      return Promise.resolve(row);
    },
  };

  type NotificationWhere = {
    id?: string;
    status?: string | { in: string[] };
    recipientType?: string;
    recipientId?: string;
    channel?: string;
    nextAttemptAt?: null | { lte: Date };
    readAt?: null;
    OR?: ({ nextAttemptAt: null } | { nextAttemptAt: { lte: Date } })[];
  };
  const matchNotification = (where: NotificationWhere) => (n: NotificationRow) => {
    if (where.id !== undefined && n.id !== where.id) return false;
    if (where.status !== undefined) {
      const matches =
        typeof where.status === 'string'
          ? n.status === where.status
          : where.status.in.includes(n.status);
      if (!matches) return false;
    }
    if (where.recipientType !== undefined && n.recipientType !== where.recipientType) return false;
    if (where.recipientId !== undefined && n.recipientId !== where.recipientId) return false;
    if (where.channel !== undefined && n.channel !== where.channel) return false;
    if (where.readAt === null && n.readAt !== null) return false;
    if (where.OR) {
      const matchesOr = where.OR.some((clause) =>
        clause.nextAttemptAt === null
          ? n.nextAttemptAt === null
          : n.nextAttemptAt !== null &&
            n.nextAttemptAt.getTime() <= clause.nextAttemptAt.lte.getTime(),
      );
      if (!matchesOr) return false;
    }
    return true;
  };

  const notificationTable = {
    create: ({
      data,
    }: {
      data: {
        outboxEventId: string;
        type: string;
        category: string;
        recipientType: string;
        recipientId: string;
        channel: string;
        title: string;
        body: string;
        contactAddress?: string | null;
        status?: string;
      };
    }) => {
      if (
        notifications.some(
          (n) =>
            n.outboxEventId === data.outboxEventId &&
            n.recipientType === data.recipientType &&
            n.recipientId === data.recipientId &&
            n.channel === data.channel,
        )
      ) {
        throw prismaUniqueError(['outboxEventId', 'recipientType', 'recipientId', 'channel']);
      }
      const row: NotificationRow = {
        id: randomUUID(),
        outboxEventId: data.outboxEventId,
        type: data.type,
        category: data.category,
        recipientType: data.recipientType,
        recipientId: data.recipientId,
        channel: data.channel,
        title: data.title,
        body: data.body,
        contactAddress: data.contactAddress ?? null,
        status: data.status ?? 'PENDING',
        readAt: null,
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        providerMessageId: null,
        sentAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      notifications.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({ where }: { where: { id: string } }) => {
      return Promise.resolve(notifications.find((n) => n.id === where.id) ?? null);
    },
    findFirst: ({ where }: { where: NotificationWhere }) => {
      return Promise.resolve(notifications.find(matchNotification(where)) ?? null);
    },
    findMany: ({
      where,
      orderBy,
      take,
      cursor,
      skip,
    }: {
      where: NotificationWhere;
      orderBy?: { createdAt?: 'asc' | 'desc'; updatedAt?: 'asc' | 'desc' };
      take?: number;
      cursor?: { id: string };
      skip?: number;
    }) => {
      let matches = notifications.filter(matchNotification(where));
      if (orderBy?.createdAt === 'desc') {
        matches = [...matches].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      } else if (orderBy?.createdAt === 'asc') {
        matches = [...matches].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      } else if (orderBy?.updatedAt === 'desc') {
        matches = [...matches].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      }
      if (cursor) {
        const cursorIndex = matches.findIndex((n) => n.id === cursor.id);
        matches = cursorIndex === -1 ? [] : matches.slice(cursorIndex + (skip ?? 0));
      }
      if (take !== undefined) matches = matches.slice(0, take);
      return Promise.resolve(matches);
    },
    count: ({ where }: { where: NotificationWhere }) => {
      return Promise.resolve(notifications.filter(matchNotification(where)).length);
    },
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: Omit<Partial<NotificationRow>, 'attempts'> & { attempts?: { increment: number } };
    }) => {
      const row = notifications.find((n) => n.id === where.id);
      if (!row) throw new Error(`notification ${where.id} not found`);
      if (data.attempts) {
        row.attempts += data.attempts.increment;
      }
      const { attempts: _attempts, ...rest } = data;
      Object.assign(row, omitUndefined(rest), { updatedAt: new Date() });
      return Promise.resolve(row);
    },
    updateMany: ({ where, data }: { where: NotificationWhere; data: Partial<NotificationRow> }) => {
      const matches = notifications.filter(matchNotification(where));
      for (const row of matches) {
        Object.assign(row, omitUndefined(data), { updatedAt: new Date() });
      }
      return Promise.resolve({ count: matches.length });
    },
  };

  const notificationPreferenceTable = {
    findMany: ({ where }: { where: { recipientType: string; recipientId: string } }) => {
      return Promise.resolve(
        notificationPreferences.filter(
          (p) => p.recipientType === where.recipientType && p.recipientId === where.recipientId,
        ),
      );
    },
    findUnique: ({
      where,
    }: {
      where: {
        recipientType_recipientId_category_channel: {
          recipientType: string;
          recipientId: string;
          category: string;
          channel: string;
        };
      };
    }) => {
      const key = where.recipientType_recipientId_category_channel;
      return Promise.resolve(
        notificationPreferences.find(
          (p) =>
            p.recipientType === key.recipientType &&
            p.recipientId === key.recipientId &&
            p.category === key.category &&
            p.channel === key.channel,
        ) ?? null,
      );
    },
    upsert: ({
      where,
      create,
      update,
    }: {
      where: {
        recipientType_recipientId_category_channel: {
          recipientType: string;
          recipientId: string;
          category: string;
          channel: string;
        };
      };
      create: {
        recipientType: string;
        recipientId: string;
        category: string;
        channel: string;
        enabled: boolean;
      };
      update: { enabled: boolean };
    }) => {
      const key = where.recipientType_recipientId_category_channel;
      const existing = notificationPreferences.find(
        (p) =>
          p.recipientType === key.recipientType &&
          p.recipientId === key.recipientId &&
          p.category === key.category &&
          p.channel === key.channel,
      );
      if (existing) {
        Object.assign(existing, update, { updatedAt: new Date() });
        return Promise.resolve(existing);
      }
      const row: NotificationPreferenceRow = {
        id: randomUUID(),
        recipientType: create.recipientType,
        recipientId: create.recipientId,
        category: create.category,
        channel: create.channel,
        enabled: create.enabled,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      notificationPreferences.push(row);
      return Promise.resolve(row);
    },
  };

  const adminUserTable = {
    create: ({ data }: { data: { userId: string; role: string; status?: string } }) => {
      if (adminUsers.some((a) => a.userId === data.userId)) {
        throw prismaUniqueError(['userId']);
      }
      const row: AdminUserRow = {
        id: randomUUID(),
        userId: data.userId,
        role: data.role,
        status: (data.status as AdminUserRow['status']) ?? 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      adminUsers.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({ where }: { where: { userId: string } }) => {
      return Promise.resolve(adminUsers.find((a) => a.userId === where.userId) ?? null);
    },
    findMany: ({
      orderBy,
      take: takeCount,
      include,
    }: {
      orderBy?: { createdAt: 'asc' | 'desc' };
      take?: number;
      include?: { user?: unknown };
    }) => {
      let matches = [...adminUsers];
      if (orderBy?.createdAt === 'desc') {
        matches = matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      if (takeCount !== undefined) matches = matches.slice(0, takeCount);
      return Promise.resolve(
        matches.map((a) => {
          if (!include?.user) return a;
          const u = users.find((u) => u.id === a.userId);
          return { ...a, user: u ? { id: u.id, fullName: u.fullName, email: u.email } : null };
        }),
      );
    },
    count: ({ where }: { where: { role: string; status: string } }) => {
      return Promise.resolve(
        adminUsers.filter((a) => a.role === where.role && a.status === where.status).length,
      );
    },
    update: ({ where, data }: { where: { id: string }; data: Partial<AdminUserRow> }) => {
      const row = adminUsers.find((a) => a.id === where.id);
      if (!row) throw new Error(`adminUser ${where.id} not found`);
      Object.assign(row, omitUndefined(data), { updatedAt: new Date() });
      return Promise.resolve(row);
    },
  };

  interface PromotionCreateData {
    restaurantId: string | null;
    code: string;
    name: string;
    type: PromotionRow['type'];
    value: number;
    minOrderMinor?: bigint;
    maxDiscountMinor?: bigint;
    startsAt?: Date;
    endsAt?: Date;
    usageLimitTotal?: number;
    usageLimitPerCustomer?: number;
    firstOrderOnly?: boolean;
    createdByUserId: string;
  }
  interface PromotionWhere {
    id?: string;
    code?: string;
    isActive?: boolean;
    archivedAt?: null;
    restaurantId?: string | null;
  }
  function matchPromotion(where: PromotionWhere) {
    return (p: PromotionRow) => {
      if (where.id !== undefined && p.id !== where.id) return false;
      if (where.code !== undefined && p.code !== where.code) return false;
      if (where.isActive !== undefined && p.isActive !== where.isActive) return false;
      if (where.archivedAt === null && p.archivedAt !== null) return false;
      if (where.restaurantId !== undefined && p.restaurantId !== where.restaurantId) return false;
      return true;
    };
  }
  const promotionTable = {
    create: ({ data }: { data: PromotionCreateData }) => {
      const row: PromotionRow = {
        id: randomUUID(),
        restaurantId: data.restaurantId,
        code: data.code,
        name: data.name,
        type: data.type,
        value: data.value,
        minOrderMinor: data.minOrderMinor ?? null,
        maxDiscountMinor: data.maxDiscountMinor ?? null,
        startsAt: data.startsAt ?? null,
        endsAt: data.endsAt ?? null,
        usageLimitTotal: data.usageLimitTotal ?? null,
        usageLimitPerCustomer: data.usageLimitPerCustomer ?? null,
        firstOrderOnly: data.firstOrderOnly ?? false,
        isActive: true,
        createdByUserId: data.createdByUserId,
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      promotions.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({ where }: { where: { id: string } }) => {
      return Promise.resolve(promotions.find((p) => p.id === where.id) ?? null);
    },
    findUniqueOrThrow: ({ where }: { where: { id: string } }) => {
      const row = promotions.find((p) => p.id === where.id);
      if (!row) throw new Error(`promotion ${where.id} not found`);
      return Promise.resolve(row);
    },
    findFirst: ({ where }: { where: PromotionWhere }) => {
      return Promise.resolve(promotions.find(matchPromotion(where)) ?? null);
    },
    findMany: ({
      where,
      orderBy,
      cursor,
      skip,
      take,
    }: {
      where: PromotionWhere;
      orderBy?: { createdAt: 'asc' | 'desc' };
      cursor?: { id: string };
      skip?: number;
      take?: number;
    }) => {
      let matches = promotions.filter(matchPromotion(where));
      if (orderBy?.createdAt === 'desc') {
        matches = [...matches].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      } else if (orderBy?.createdAt === 'asc') {
        matches = [...matches].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      if (cursor) {
        const cursorIndex = matches.findIndex((p) => p.id === cursor.id);
        matches = cursorIndex === -1 ? [] : matches.slice(cursorIndex + (skip ?? 0));
      }
      if (take !== undefined) matches = matches.slice(0, take);
      return Promise.resolve(matches);
    },
    update: ({ where, data }: { where: { id: string }; data: Partial<PromotionRow> }) => {
      const row = promotions.find((p) => p.id === where.id);
      if (!row) throw new Error(`promotion ${where.id} not found`);
      Object.assign(row, omitUndefined(data), { updatedAt: new Date() });
      return Promise.resolve(row);
    },
  };

  interface PromotionRedemptionWhere {
    promotionId?: string;
    customerPhone?: string;
    orderId?: string;
    status?: string | { in: string[] };
  }
  function matchPromotionRedemption(where: PromotionRedemptionWhere) {
    return (r: PromotionRedemptionRow) => {
      if (where.promotionId !== undefined && r.promotionId !== where.promotionId) return false;
      if (where.customerPhone !== undefined && r.customerPhone !== where.customerPhone)
        return false;
      if (where.orderId !== undefined && r.orderId !== where.orderId) return false;
      if (where.status !== undefined) {
        const matches =
          typeof where.status === 'string'
            ? r.status === where.status
            : where.status.in.includes(r.status);
        if (!matches) return false;
      }
      return true;
    };
  }
  const promotionRedemptionTable = {
    create: ({
      data,
    }: {
      data: Omit<PromotionRedemptionRow, 'id' | 'reservedAt' | 'expiresAt' | 'confirmedAt'> &
        Partial<Pick<PromotionRedemptionRow, 'expiresAt'>>;
    }) => {
      const row: PromotionRedemptionRow = {
        id: randomUUID(),
        promotionId: data.promotionId,
        customerId: data.customerId,
        customerPhone: data.customerPhone,
        orderId: data.orderId ?? null,
        status: data.status,
        discountMinor: data.discountMinor,
        reservedAt: new Date(),
        expiresAt: data.expiresAt ?? null,
        confirmedAt: null,
      };
      promotionRedemptions.push(row);
      return Promise.resolve(row);
    },
    count: ({ where }: { where: PromotionRedemptionWhere }) => {
      return Promise.resolve(promotionRedemptions.filter(matchPromotionRedemption(where)).length);
    },
    findMany: ({ where }: { where: PromotionRedemptionWhere }) => {
      return Promise.resolve(promotionRedemptions.filter(matchPromotionRedemption(where)));
    },
    updateMany: ({
      where,
      data,
    }: {
      where: PromotionRedemptionWhere;
      data: Partial<PromotionRedemptionRow>;
    }) => {
      const matches = promotionRedemptions.filter(matchPromotionRedemption(where));
      for (const row of matches) {
        Object.assign(row, omitUndefined(data));
      }
      return Promise.resolve({ count: matches.length });
    },
  };

  const prisma = {
    user,
    session,
    otpChallenge,
    auditLog,
    restaurant: restaurantTable,
    restaurantStaff: restaurantStaffTable,
    restaurantAddress: restaurantAddressTable,
    restaurantBranding: restaurantBrandingTable,
    restaurantSettings: restaurantSettingsTable,
    staffInvitation: staffInvitationTable,
    menuCategory: menuCategoryTable,
    menuItem: menuItemTable,
    operatingHours: operatingHoursTable,
    specialHours: specialHoursTable,
    closurePeriod: closurePeriodTable,
    customer: customerTable,
    cart: cartTable,
    order: orderTable,
    orderStatusHistory: orderStatusHistoryTable,
    payment: paymentTable,
    refund: refundTable,
    webhookEvent: webhookEventTable,
    reconciliationIssue: reconciliationIssueTable,
    delivery: deliveryTable,
    outboxEvent: outboxEventTable,
    notification: notificationTable,
    notificationPreference: notificationPreferenceTable,
    adminUser: adminUserTable,
    promotion: promotionTable,
    promotionRedemption: promotionRedemptionTable,
    // Supports both Prisma `$transaction` forms this codebase uses: the
    // array form (a list of already-constructed operations, awaited
    // together — see session.repository.ts) and the interactive
    // callback form (`async (tx) => {...}` — see restaurant.service.ts).
    // For the callback form, `tx` is just `prisma` itself: this fake has
    // no real transactional isolation to provide EXCEPT for the global
    // serialization below, added for Phase 14 — see `transactionQueue`'s
    // own doc comment for why.
    $transaction: (
      arg: Promise<unknown>[] | ((tx: PrismaService) => Promise<unknown>),
    ): Promise<unknown> => {
      if (typeof arg === 'function') {
        const result = transactionQueue.then(() => arg(prisma));
        transactionQueue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      }
      return Promise.all(arg);
    },
    // The only real `$queryRaw` caller today: PromotionReservationService's
    // row-lock query (`SELECT id FROM promotions WHERE code = ${code}
    // AND is_active = true AND archived_at IS NULL FOR UPDATE`) — not a
    // general SQL interpreter, deliberately: it recognises this one
    // shape by its single interpolated value (the normalised code) and
    // answers with the same WHERE-clause semantics the real query has.
    // A literal row lock is unnecessary to simulate here — the
    // serialized `$transaction` above is this fake's actual
    // concurrency-safety mechanism (real Postgres's `FOR UPDATE` only
    // blocks other transactions from proceeding past their own lock
    // attempt; globally serializing callbacks achieves the same
    // observable effect for every test in this suite).
    $queryRaw: (_strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      const code = values[0] as string;
      const match = promotions.find((p) => p.code === code && p.isActive && !p.archivedAt);
      return Promise.resolve(match ? [{ id: match.id }] : []);
    },
    ping: () => Promise.resolve(),
  } as unknown as PrismaService;

  return {
    users,
    sessions,
    otpChallenges,
    auditLogs,
    restaurants,
    restaurantStaff,
    restaurantAddresses,
    restaurantBranding,
    restaurantSettings,
    staffInvitations,
    menuCategories,
    menuItems,
    operatingHours,
    specialHours,
    closurePeriods,
    customers,
    carts,
    cartItems,
    orders,
    orderItems,
    orderStatusHistory,
    payments,
    refunds,
    webhookEvents,
    reconciliationIssues,
    deliveries,
    outboxEvents,
    notifications,
    notificationPreferences,
    adminUsers,
    promotions,
    promotionRedemptions,
    prisma,
  };
}
