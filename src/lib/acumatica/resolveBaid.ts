import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type ResolveInput = {
  userId?: string | null;
  email?: string | null;
  baid?: string | null;
};

function normalizeEmail(email: string | null | undefined) {
  return email ? email.toLowerCase().trim() : null;
}

function normalizeBaid(baid: string | null | undefined) {
  return baid ? baid.trim().toUpperCase() : null;
}

export async function resolveSingleBaid(input: ResolveInput) {
  const userId = input.userId ?? null;
  const email = normalizeEmail(input.email ?? null);
  const baidIn = normalizeBaid(input.baid ?? null);

  if (baidIn && (userId || email)) {
    const user = userId
      ? await prisma.users.findUnique({
          where: { id: userId },
          select: { baid: true, isDeveloper: true },
        })
      : await prisma.users.findUnique({
          where: { email: email! },
          select: { baid: true, isDeveloper: true },
        });
    if (!user) throw new Error("User not found.");
    if (user.isDeveloper) return baidIn;
    if (!user.baid) throw new Error("User not found or has no BAID.");
    if (user.baid !== baidIn) throw new Error("Provided BAID does not match user's BAID.");
    return baidIn;
  }

  if (baidIn) return baidIn;

  if (userId || email) {
    const user = userId
      ? await prisma.users.findUnique({ where: { id: userId }, select: { baid: true } })
      : await prisma.users.findUnique({ where: { email: email! }, select: { baid: true } });
    if (!user?.baid) throw new Error("No BAID found for the given userId/email.");
    return user.baid;
  }

  throw new Error("Provide baid or a resolvable userId/email.");
}
