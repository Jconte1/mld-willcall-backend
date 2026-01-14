"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveSingleBaid = resolveSingleBaid;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
function normalizeEmail(email) {
    return email ? email.toLowerCase().trim() : null;
}
function normalizeBaid(baid) {
    return baid ? baid.trim().toUpperCase() : null;
}
async function resolveSingleBaid(input) {
    const userId = input.userId ?? null;
    const email = normalizeEmail(input.email ?? null);
    const baidIn = normalizeBaid(input.baid ?? null);
    if (baidIn && (userId || email)) {
        const user = userId
            ? await prisma.users.findUnique({ where: { id: userId }, select: { baid: true } })
            : await prisma.users.findUnique({ where: { email: email }, select: { baid: true } });
        if (!user?.baid)
            throw new Error("User not found or has no BAID.");
        if (user.baid !== baidIn)
            throw new Error("Provided BAID does not match user's BAID.");
        return baidIn;
    }
    if (baidIn)
        return baidIn;
    if (userId || email) {
        const user = userId
            ? await prisma.users.findUnique({ where: { id: userId }, select: { baid: true } })
            : await prisma.users.findUnique({ where: { email: email }, select: { baid: true } });
        if (!user?.baid)
            throw new Error("No BAID found for the given userId/email.");
        return user.baid;
    }
    throw new Error("Provide baid or a resolvable userId/email.");
}
