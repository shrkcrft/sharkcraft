import { lookupUser } from '../domain/users';

export function handleRequest(id: string): unknown {
  return lookupUser(id);
}
