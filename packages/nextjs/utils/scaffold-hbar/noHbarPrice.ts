// Build-time replacement for the price module of @scaffold-hbar-ui/hooks (wired in next.config.ts).
// It must keep that module's two exports.

export const HBAR_PRICE_CACHE_DURATION_MS = 60 * 1000;

/** 0 is the UI kit's own "price unknown": Balance and HbarInput then show HBAR and disable their USD toggle. */
export async function fetchHbarPrice(): Promise<number> {
  return 0;
}
