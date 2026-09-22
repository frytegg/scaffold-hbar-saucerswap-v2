export type AccountBadge = { accountId: string };

export function formatAmount(tinybar: bigint): string {
  return `${tinybar} tinybar`;
}
