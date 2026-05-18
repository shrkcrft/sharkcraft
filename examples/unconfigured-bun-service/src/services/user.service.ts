export class UserService {
  private nextId = 1;
  private readonly users = new Map<number, string>();

  create(name: string): number {
    const id = this.nextId++;
    this.users.set(id, name);
    return id;
  }

  find(id: number): string | undefined {
    return this.users.get(id);
  }
}
