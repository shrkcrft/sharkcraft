export interface IUser {
  id: string;
  email: string;
  displayName: string;
}

export class UserService {
  private users = new Map<string, IUser>();

  init(): void {
    this.users.set('1', { id: '1', email: 'alice@example.com', displayName: 'Alice' });
    this.users.set('2', { id: '2', email: 'bob@example.com', displayName: 'Bob' });
  }

  async findById(id: string): Promise<IUser | null> {
    return this.users.get(id) ?? null;
  }
}
