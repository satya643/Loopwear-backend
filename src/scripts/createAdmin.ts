import type { Role } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { hashSecret } from "../lib/password";
import { phoneSchema } from "../modules/auth/schemas";

/**
 * CLI for creating (or promoting) an operator/admin account — there is no
 * API route for this, and deliberately so: role defaults to "customer" and
 * sign-up never accepts a role from the client (see modules/auth/schemas.ts).
 * This is the supported way to get an operator/admin account outside of
 * hand-editing prisma/seed.ts.
 *
 * Upserts by email: an existing account (even a "customer") is promoted in
 * place — role, verified and password are all overwritten to what you pass.
 */
export async function createAdmin(input: {
  email: string;
  name: string;
  phone: string;
  password: string;
  role?: Role;
}) {
  const role: Role = input.role ?? "admin";
  if (role !== "admin" && role !== "operator") {
    throw new Error(`--role must be "admin" or "operator", got "${role}"`);
  }

  const phone = phoneSchema.parse(input.phone);
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashSecret(input.password);

  return prisma.user.upsert({
    where: { email },
    update: { name: input.name, phone, passwordHash, role, verified: true },
    create: { name: input.name, email, phone, passwordHash, role, verified: true },
  });
}

function parseArgs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function usageAndExit(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    'Usage: npm run admin:create -- --email=you@example.com --name="Ops Admin" --phone=+919800000000 --password=Secret123! [--role=admin|operator]'
  );
  process.exit(1);
}

if (require.main === module) {
  const args = parseArgs();
  if (!args.email || !args.name || !args.phone || !args.password) {
    usageAndExit("--email, --name, --phone and --password are all required");
  }

  createAdmin({
    email: args.email,
    name: args.name,
    phone: args.phone,
    password: args.password,
    role: args.role as Role | undefined,
  })
    .then((user) => {
      // eslint-disable-next-line no-console
      console.log(`✓ ${user.role} account ready: ${user.email} (id: ${user.id})`);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
