import { Inject, Injectable } from '@nestjs/common';
import type { ReconciliationIssue, ReconciliationSeverity } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface CreateReconciliationIssueInput {
  entityType: string;
  entityId: string;
  issueType: string;
  expected?: string;
  actual?: string;
  severity: ReconciliationSeverity;
}

/** Records mismatches; never silently corrects financial data (docs/01-domain-model.md §5.6). */
@Injectable()
export class ReconciliationIssueRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateReconciliationIssueInput): Promise<ReconciliationIssue> {
    return this.prisma.reconciliationIssue.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        issueType: input.issueType,
        expected: input.expected,
        actual: input.actual,
        severity: input.severity,
      },
    });
  }

  async listOpen(): Promise<ReconciliationIssue[]> {
    return this.prisma.reconciliationIssue.findMany({
      where: { status: 'OPEN' },
      orderBy: { detectedAt: 'desc' },
    });
  }
}
