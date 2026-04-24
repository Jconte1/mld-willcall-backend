"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLoginThrottleState = getLoginThrottleState;
exports.recordFailedLogin = recordFailedLogin;
exports.clearFailedLogin = clearFailedLogin;
const prisma_1 = require("./prisma");
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 60 * 60 * 1000; // 1 hour rolling window
const LOGIN_LOCK_MS = 15 * 60 * 1000; // 15 minute lockout
function keyFor(type, email) {
    return `login:${type}:${email.toLowerCase().trim()}`;
}
async function getLoginThrottleState(type, email) {
    const now = new Date();
    const key = keyFor(type, email);
    const row = await prisma_1.prisma.passwordResetThrottle.findUnique({ where: { key } });
    if (!row)
        return { blocked: false, attemptsLeft: LOGIN_MAX_ATTEMPTS };
    if (row.lockedUntil && row.lockedUntil > now) {
        return { blocked: true, attemptsLeft: 0, lockedUntil: row.lockedUntil };
    }
    const sameWindow = now.getTime() - row.windowStart.getTime() < LOGIN_WINDOW_MS;
    if (!sameWindow)
        return { blocked: false, attemptsLeft: LOGIN_MAX_ATTEMPTS };
    return {
        blocked: false,
        attemptsLeft: Math.max(0, LOGIN_MAX_ATTEMPTS - row.count),
    };
}
async function recordFailedLogin(type, email) {
    const now = new Date();
    const key = keyFor(type, email);
    const row = await prisma_1.prisma.passwordResetThrottle.findUnique({ where: { key } });
    if (!row) {
        await prisma_1.prisma.passwordResetThrottle.create({
            data: { key, count: 1, windowStart: now, lockedUntil: null },
        });
        return { blocked: false, attemptsLeft: LOGIN_MAX_ATTEMPTS - 1 };
    }
    if (row.lockedUntil && row.lockedUntil > now) {
        return { blocked: true, attemptsLeft: 0, lockedUntil: row.lockedUntil };
    }
    const sameWindow = now.getTime() - row.windowStart.getTime() < LOGIN_WINDOW_MS;
    const nextCount = sameWindow ? row.count + 1 : 1;
    const lockedUntil = nextCount >= LOGIN_MAX_ATTEMPTS ? new Date(now.getTime() + LOGIN_LOCK_MS) : null;
    await prisma_1.prisma.passwordResetThrottle.update({
        where: { key },
        data: {
            count: nextCount,
            windowStart: sameWindow ? row.windowStart : now,
            lockedUntil,
        },
    });
    if (lockedUntil)
        return { blocked: true, attemptsLeft: 0, lockedUntil };
    return { blocked: false, attemptsLeft: Math.max(0, LOGIN_MAX_ATTEMPTS - nextCount) };
}
async function clearFailedLogin(type, email) {
    const key = keyFor(type, email);
    await prisma_1.prisma.passwordResetThrottle.updateMany({
        where: { key },
        data: { count: 0, lockedUntil: null, windowStart: new Date() },
    });
}
