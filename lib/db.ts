import { PrismaClient } from "@prisma/client";

declare global {
  var __prisma: PrismaClient | undefined;
}

// The headless suite writes real rows (users, documents, scheduled tasks). It used
// to run against prisma/dev.db — production — because Prisma falls back to .env's
// DATABASE_URL: by 2026-10 about 940 of 1,069 ScheduledTask rows were fixtures from
// @example.com users, one of which the live scheduler fired every day. `npm test`
// now points DATABASE_URL at prisma/test.db; this refuses the production file for
// any test run that bypasses the script (e.g. `npx tsx --test tests/x.test.ts`).
export function isTestRunner(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(
    env.NODE_ENV === "test" ||
      env.NODE_TEST_CONTEXT ||
      env.VITEST ||
      env.JEST_WORKER_ID ||
      env.npm_lifecycle_event?.startsWith("test")
  );
}

export function productionDatabaseRefusal(env: Record<string, string | undefined> = process.env): string | null {
  if (!isTestRunner(env)) return null;
  const url = env.DATABASE_URL ?? "";
  if (url !== "" && !/(^|[/:])dev\.db(\?|$)/.test(url)) return null;
  return (
    `[db] refusing to run tests against the production database (DATABASE_URL=${url || "<unset, .env>"}). ` +
    "Run `npm test`, or set DATABASE_URL=file:./test.db after `DATABASE_URL=file:./test.db npx prisma db push`."
  );
}

const refusal = productionDatabaseRefusal();
if (refusal) throw new Error(refusal);

export const db =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
  });

if (process.env.NODE_ENV !== "production") {
  global.__prisma = db;
}
