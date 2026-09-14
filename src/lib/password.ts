import bcrypt from "bcryptjs";

const COST = 10;

export function hashSecret(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function compareSecret(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
