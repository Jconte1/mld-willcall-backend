"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
const client_1 = require("@prisma/client");
const PrismaCtor = client_1.PrismaClient;
const globalForPrisma = globalThis;
exports.prisma = globalForPrisma.prisma ?? new PrismaCtor();
if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = exports.prisma;
}
