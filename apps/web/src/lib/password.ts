import bcrypt from "bcryptjs";

const ROUNDS = 12;

/** Too many password hashes / compares are already waiting: answer 503 instead of queueing more. */
export class BcryptBusyError extends Error {
  constructor() {
    super("bcrypt_busy");
  }
}

/**
 * Process-wide cap on concurrent bcrypt work (security audit "register → web CPU DoS"): pure-JS
 * bcryptjs at cost 12 takes ≈250–370 ms of CPU per call, and several interleaved calls froze every
 * route (the game server's settlement calls included). At most `concurrency` run at once, a burst
 * waits in line, and past `maxQueue` waiting calls a new one fails fast with BcryptBusyError.
 */
export class BcryptGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly concurrency = 2,
    private readonly maxQueue = 100,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxQueue) throw new BcryptBusyError();
      // The releasing call hands its slot over (active stays the same).
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  get queued(): number {
    return this.waiting.length;
  }
}

const gate = new BcryptGate();

export async function hashPassword(plain: string): Promise<string> {
  return gate.run(() => bcrypt.hash(plain, ROUNDS));
}

/** A valid cost-12 hash of a throwaway string: compared against for unknown emails so the
 *  response time does not reveal which emails have accounts. */
const DUMMY_HASH = "$2a$12$O.QQrLkVD5MvrlYZQ8be7ujDayehti79y3YSot3bf3qkwXrrn5fcW";

/** Same cost as verifyPassword, always false. */
export async function burnPasswordCompare(plain: string): Promise<false> {
  await gate.run(() => bcrypt.compare(plain, DUMMY_HASH));
  return false;
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return gate.run(() => bcrypt.compare(plain, hash));
}
