import { defineConfig } from "prisma/config";

const defaultDatabaseUrl = "file:./prisma/dev.db";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL ?? defaultDatabaseUrl,
  },
});
