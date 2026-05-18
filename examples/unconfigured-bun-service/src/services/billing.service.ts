export class BillingService {
  charge(user: number, amountCents: number): { ok: boolean; reference: string } {
    if (amountCents <= 0) return { ok: false, reference: '' };
    return { ok: true, reference: `bill-${user}-${amountCents}` };
  }
}
