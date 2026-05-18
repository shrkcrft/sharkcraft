import { describe, expect, test } from 'bun:test';
import { UserService } from '../src/services/user.service.ts';

describe('UserService', () => {
  test('create assigns increasing ids', () => {
    const s = new UserService();
    const a = s.create('alice');
    const b = s.create('bob');
    expect(b).toBeGreaterThan(a);
  });

  test('find returns the stored name', () => {
    const s = new UserService();
    const id = s.create('alice');
    expect(s.find(id)).toBe('alice');
  });
});
