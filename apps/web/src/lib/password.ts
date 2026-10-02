import bcrypt from "bcryptjs";

const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

/** A valid cost-12 hash of a throwaway string: compared against for unknown emails so the
 *  response time does not reveal which emails have accounts. */
const DUMMY_HASH = "$2a$12$O.QQrLkVD5MvrlYZQ8be7ujDayehti79y3YSot3bf3qkwXrrn5fcW";

/** Same cost as verifyPassword, always false. */
export async function burnPasswordCompare(plain: string): Promise<false> {
  await bcrypt.compare(plain, DUMMY_HASH);
  return false;
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
