import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

const MAX_TOKEN_DAYS = 30;
const END_PLUS_DAYS = 7;

export function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

export function computeTokenExpiry(endAt: Date, issuedAt: Date = new Date()) {
  const endPlus = new Date(endAt.getTime() + END_PLUS_DAYS * 24 * 60 * 60 * 1000);
  const maxExpiry = new Date(issuedAt.getTime() + MAX_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  return endPlus < maxExpiry ? endPlus : maxExpiry;
}

export async function createAppointmentToken(
  prisma: PrismaClient,
  appointmentId: string,
  endAt: Date
) {
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

export async function rotateAppointmentToken(
  prisma: PrismaClient,
  appointmentId: string,
  endAt: Date
) {
  await prisma.appointmentAccessToken.updateMany({
    where: { appointmentId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return createAppointmentToken(prisma, appointmentId, endAt);
}

export async function getActiveToken(prisma: PrismaClient, appointmentId: string) {
  return prisma.appointmentAccessToken.findFirst({
    where: {
      appointmentId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { issuedAt: "desc" },
  });
}

export async function createOrderReadyToken(prisma: PrismaClient, orderReadyId: string) {
  const rawToken = generateToken();
  await prisma.orderReadyAccessToken.create({
    data: {
      orderReadyId,
      token: rawToken,
    },
  });
  return { token: rawToken };
}

export async function getActiveOrderReadyToken(prisma: PrismaClient, orderReadyId: string) {
  return prisma.orderReadyAccessToken.findFirst({
    where: {
      orderReadyId,
      revokedAt: null,
    },
    orderBy: { issuedAt: "desc" },
  });
}

export async function rotateOrderReadyToken(prisma: PrismaClient, orderReadyId: string) {
  await prisma.orderReadyAccessToken.updateMany({
    where: { orderReadyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return createOrderReadyToken(prisma, orderReadyId);
}
