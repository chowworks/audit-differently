import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { appRoleGrantsSql } from './app-role-grants'

/**
 * The restricted role the API connects as, set up by the database owner: scripts/create-app-role.ts by hand, and
 * scripts/ensure-app-role.ts on every deploy (after the migrations, so the functions it grants exist).
 */

/** The role and its password, as the API's DATABASE_URL names them. */
export function appRoleFromUrl(url: string): { role: string; password: string } {
  const u = new URL(url)
  const role = decodeURIComponent(u.username)
  const password = decodeURIComponent(u.password)
  if (!/^[a-z_][a-z0-9_]*$/.test(role))
    throw new Error('DATABASE_URL must name a plain role (lowercase letters, digits and _)')
  // Printable ASCII, so the server's SASLprep leaves it as it is and the verifier below matches a login.
  if (password.length < 24 || !/^[\x21-\x7e]+$/.test(password))
    throw new Error(
      'The password in DATABASE_URL must be 24 or more characters, letters, digits and symbols only'
    )
  return { role, password }
}

/**
 * The SCRAM-SHA-256 verifier Postgres stores for `password` (RFC 5802, 7677). A role's password set from it never
 * reaches the server in plain text, so it cannot surface in a statement log.
 */
export function scramVerifier(password: string, salt = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const hmac = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest()
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest()
  const serverKey = hmac(salted, 'Server Key')
  const b64 = (b: Buffer) => b.toString('base64')
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`
}

const VERIFIER = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/

/**
 * Everything that makes `role` the API's restricted role in database `db`: a login that can never bypass row-level
 * security, its password (a verifier; null leaves the current one), table access, and exactly the functions in
 * app-role-grants.ts, also for tables later migrations make. Safe to run again: it converges, it does not stack.
 */
export function appRoleSql(
  role: string,
  db: string,
  { exists, verifier }: { exists: boolean; verifier: string | null }
): string[] {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('The role must be a plain identifier')
  if (!/^[A-Za-z0-9_-]+$/.test(db)) throw new Error('The database name must be a plain name')
  if (verifier !== null && !VERIFIER.test(verifier)) throw new Error('Not a SCRAM-SHA-256 verifier')
  if (!exists && verifier === null) throw new Error('A new role needs a password')
  const limits = 'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE'
  return [
    exists
      ? `ALTER ROLE ${role} ${limits}`
      : `CREATE ROLE ${role} ${limits} PASSWORD '${verifier}'`,
    ...(exists && verifier ? [`ALTER ROLE ${role} PASSWORD '${verifier}'`] : []),
    `GRANT CONNECT ON DATABASE "${db}" TO ${role}`,
    ...appRoleGrantsSql(role),
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM ${role}`,
  ]
}
