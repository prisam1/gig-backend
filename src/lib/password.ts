import { hash, verify } from '@node-rs/argon2';

// Argon2id (library default) with OWASP-recommended cost: 19 MiB memory, 2 passes, 1 lane.
const options = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, options);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Verifying against this when the account does not exist keeps response times the same,
// so login timing does not reveal which emails or phones are registered.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hash('timing-equaliser-not-a-real-password', options);
  await verifyPassword(await dummyHash, password);
}
