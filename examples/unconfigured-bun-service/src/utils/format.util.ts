/** Format a currency amount stored in cents as a human-readable string. */
export function formatCents(amountCents: number): string {
  const sign = amountCents < 0 ? '-' : '';
  const cents = Math.abs(amountCents);
  const major = Math.floor(cents / 100);
  const minor = String(cents % 100).padStart(2, '0');
  return `${sign}$${major}.${minor}`;
}
