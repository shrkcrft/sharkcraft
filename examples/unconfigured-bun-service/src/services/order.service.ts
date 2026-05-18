export class OrderService {
  private nextId = 1;
  private readonly orders = new Map<number, { user: number; items: string[] }>();

  place(user: number, items: string[]): number {
    const id = this.nextId++;
    this.orders.set(id, { user, items });
    return id;
  }

  list(): { id: number; user: number; items: string[] }[] {
    return [...this.orders.entries()].map(([id, v]) => ({ id, ...v }));
  }
}
