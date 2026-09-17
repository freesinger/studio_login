import { describe, expect, it } from 'vitest';

import { isStrongPassword, strongPasswordSchema } from '../src/password-policy.js';

describe('subaccount password policy', () => {
  it('requires twelve characters and all four character classes', () => {
    for (const password of ['Short1!', 'alllowercase123!', 'ALLUPPERCASE123!', 'NoDigitsHere!', 'NoSymbolHere123']) {
      expect(isStrongPassword(password)).toBe(false);
      expect(strongPasswordSchema.safeParse(password).success).toBe(false);
    }
    expect(isStrongPassword('StrongPass123!')).toBe(true);
    expect(strongPasswordSchema.safeParse('StrongPass123!').success).toBe(true);
  });
});
