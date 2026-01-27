"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateToken = generateToken;
exports.computeTokenExpiry = computeTokenExpiry;
exports.createAppointmentToken = createAppointmentToken;
exports.rotateAppointmentToken = rotateAppointmentToken;
exports.getActiveToken = getActiveToken;
exports.createOrderReadyToken = createOrderReadyToken;
exports.getActiveOrderReadyToken = getActiveOrderReadyToken;
exports.rotateOrderReadyToken = rotateOrderReadyToken;
const node_crypto_1 = __importDefault(require("node:crypto"));
const MAX_TOKEN_DAYS = 30;
const END_PLUS_DAYS = 7;
function generateToken() {
    return node_crypto_1.default.randomBytes(24).toString("hex");
}
function computeTokenExpiry(endAt, issuedAt = new Date()) {
    const endPlus = new Date(endAt.getTime() + END_PLUS_DAYS * 24 * 60 * 60 * 1000);
    const maxExpiry = new Date(issuedAt.getTime() + MAX_TOKEN_DAYS * 24 * 60 * 60 * 1000);
    return endPlus < maxExpiry ? endPlus : maxExpiry;
}
async function createAppointmentToken(prisma, appointmentId, endAt) {
    const rawToken = generateToken();
    const expiresAt = computeTokenExpiry(endAt);
    await prisma.appointmentAccessToken.create({
        data: {
            appointmentId,
            token: rawToken,
            expiresAt,
        },
    });
    return { token: rawToken, expiresAt };
}
async function rotateAppointmentToken(prisma, appointmentId, endAt) {
    await prisma.appointmentAccessToken.updateMany({
        where: { appointmentId, revokedAt: null },
        data: { revokedAt: new Date() },
    });
    return createAppointmentToken(prisma, appointmentId, endAt);
}
async function getActiveToken(prisma, appointmentId) {
    return prisma.appointmentAccessToken.findFirst({
        where: {
            appointmentId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
        },
        orderBy: { issuedAt: "desc" },
    });
}
async function createOrderReadyToken(prisma, orderReadyId) {
    const rawToken = generateToken();
    await prisma.orderReadyAccessToken.create({
        data: {
            orderReadyId,
            token: rawToken,
        },
    });
    return { token: rawToken };
}
async function getActiveOrderReadyToken(prisma, orderReadyId) {
    return prisma.orderReadyAccessToken.findFirst({
        where: {
            orderReadyId,
            revokedAt: null,
        },
        orderBy: { issuedAt: "desc" },
    });
}
async function rotateOrderReadyToken(prisma, orderReadyId) {
    await prisma.orderReadyAccessToken.updateMany({
        where: { orderReadyId, revokedAt: null },
        data: { revokedAt: new Date() },
    });
    return createOrderReadyToken(prisma, orderReadyId);
}
