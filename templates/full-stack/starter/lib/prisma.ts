import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { PrismaClient } from "../generated/prisma/client";

const defaultDatabaseUrl = "file:./prisma/dev.db";

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};

function createPrismaClient() {
  const adapter = new PrismaBetterSqlite3(
    { url: process.env.DATABASE_URL || defaultDatabaseUrl },
    // Preserve compatibility with timestamps written by Prisma's legacy SQLite engine.
    { timestampFormat: "unixepoch-ms" },
  );

  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
