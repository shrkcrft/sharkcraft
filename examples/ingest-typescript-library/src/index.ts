export interface IUser {
  readonly id: string;
  readonly name: string;
}

export function makeUser(id: string, name: string): IUser {
  return { id, name };
}
