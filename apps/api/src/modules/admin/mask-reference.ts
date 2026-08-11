/**
 * `GET /admin/payments` (docs/04 §8.7: "Masked provider references")
 * and docs/14-acceptance-criteria.md's Phase 13 criterion "Payment
 * views mask provider references and expose no secrets" — a provider
 * order/payment id is not itself a secret (it can't authenticate
 * anything on its own), but it IS a lookup key into the live provider
 * dashboard, so it's masked here as defense-in-depth against shoulder-
 * surfing/screen-sharing an admin console. Shows only the last 4
 * characters, the same convention card-number masking uses.
 */
export function maskReference(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}
