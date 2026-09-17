import { z } from 'zod';

const specialCharacter = /[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/;

export function isStrongPassword(value: string): boolean {
  return value.length >= 12
    && value.length <= 128
    && /[A-Z]/.test(value)
    && /[a-z]/.test(value)
    && /[0-9]/.test(value)
    && specialCharacter.test(value);
}

export const strongPasswordSchema = z.string().refine(isStrongPassword, 'validation.passwordPolicy');
