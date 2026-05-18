import { UsersApi } from '../generated/api-client';

export class UsersService {
  constructor(private readonly api = new UsersApi()) {}
  all() {
    return this.api.list();
  }
}
