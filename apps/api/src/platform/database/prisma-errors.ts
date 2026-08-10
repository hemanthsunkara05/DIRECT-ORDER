/** Prisma's unique-constraint-violation error code — shared so every module's P2002-catch-and-refetch idempotency dance uses the same check. */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}
