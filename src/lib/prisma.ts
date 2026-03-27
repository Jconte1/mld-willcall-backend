import { PrismaClient } from "@prisma/client";

const PrismaCtor: typeof PrismaClient = PrismaClient;

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaCtor();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

