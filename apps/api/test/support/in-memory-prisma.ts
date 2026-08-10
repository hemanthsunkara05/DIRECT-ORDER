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
        ...data,
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
      Object.assign(row, data, { updatedAt: new Date() });
      return Promise.resolve(row);
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
        createdAt: new Date(),
        ...data,
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
      Object.assign(row, data);
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
        Object.assign(row, data);
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
        ...data,
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
        ...data,
      } as AuditLogRow;
      auditLogs.push(row);
      return Promise.resolve(row);
    },
    findMany: () => Promise.resolve([]),
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
        ...data,
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
        Object.assign(row, data, { updatedAt: new Date() });
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
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      } as RestaurantRow;
      restaurants.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({ where }: { where: { id?: string; slug?: string } }) => {
      const row =
        restaurants.find((r) => {
          if (where.id !== undefined) return r.id === where.id;
          if (where.slug !== undefined) return r.slug === where.slug;
          return false;
        }) ?? null;
      return Promise.resolve(row);
    },
    update: ({ where, data }: { where: { id: string }; data: Partial<RestaurantRow> }) => {
      const row = restaurants.find((r) => r.id === where.id);
      if (!row) throw new Error(`restaurant ${where.id} not found`);
      Object.assign(row, data, { updatedAt: new Date() });
      return Promise.resolve(row);
    },
    count: ({ where }: { where: { slug?: string } }) => {
      return Promise.resolve(
        restaurants.filter((r) => where.slug === undefined || r.slug === where.slug).length,
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
        const row = { id: randomUUID(), ...defaults, ...data } as Row;
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
          Object.assign(existing, update, 'updatedAt' in existing ? { updatedAt: new Date() } : {});
          return Promise.resolve(existing);
        }
        const row = { id: randomUUID(), ...defaults, ...create } as Row;
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
        ...data,
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
      Object.assign(row, data);
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
        Object.assign(row, data);
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
        ...data,
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
        Object.assign(row, data, { updatedAt: new Date() });
      }
      return Promise.resolve({ count: matches.length });
    },
  };

  type MenuItemWhere = {
    id?: string;
    restaurantId?: string;
    categoryId?: string;
    archivedAt?: null;
  };
  const matchMenuItem = (where: MenuItemWhere) => (i: MenuItemRow) => {
    if (where.id !== undefined && i.id !== where.id) return false;
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
        ...data,
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
        Object.assign(row, data, { updatedAt: new Date() });
      }
      return Promise.resolve({ count: matches.length });
    },
    count: ({ where }: { where: MenuItemWhere }) => {
      return Promise.resolve(menuItems.filter(matchMenuItem(where)).length);
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
    // Supports both Prisma `$transaction` forms this codebase uses: the
    // array form (a list of already-constructed operations, awaited
    // together — see session.repository.ts) and the interactive
    // callback form (`async (tx) => {...}` — see restaurant.service.ts).
    // For the callback form, `tx` is just `prisma` itself: this fake has
    // no real transactional isolation to provide, so there is nothing
    // extra a distinct `tx` object would add.
    $transaction: (
      arg: Promise<unknown>[] | ((tx: PrismaService) => Promise<unknown>),
    ): Promise<unknown> => {
      if (typeof arg === 'function') {
        return arg(prisma);
      }
      return Promise.all(arg);
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
    prisma,
  };
}
