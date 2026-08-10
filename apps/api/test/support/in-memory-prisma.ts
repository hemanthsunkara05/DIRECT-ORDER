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

export interface InMemoryPrisma {
  users: UserRow[];
  sessions: SessionRow[];
  otpChallenges: OtpChallengeRow[];
  auditLogs: AuditLogRow[];
  prisma: PrismaService;
}

export function createInMemoryPrisma(): InMemoryPrisma {
  const users: UserRow[] = [];
  const sessions: SessionRow[] = [];
  const otpChallenges: OtpChallengeRow[] = [];
  const auditLogs: AuditLogRow[] = [];

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

  const prisma = {
    user,
    session,
    otpChallenge,
    auditLog,
    $transaction: (operations: Promise<unknown>[]) => Promise.all(operations),
    ping: () => Promise.resolve(),
  } as unknown as PrismaService;

  return { users, sessions, otpChallenges, auditLogs, prisma };
}
