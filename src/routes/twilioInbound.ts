import { Router } from "express";
import { PrismaClient } from "@prisma/client";

export const twilioInboundRouter = Router();
const prisma = new PrismaClient();

const STOP_WORDS = new Set(["STOP", "STOPALL", "END", "CANCEL", "UNSUBSCRIBE", "QUIT"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES"]);

function normalizePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || null;
}

twilioInboundRouter.post("/inbound", async (req, res) => {
  const fromRaw = req.body?.From as string | undefined;
  const bodyRaw = req.body?.Body as string | undefined;
  const from = normalizePhone(fromRaw);
  const body = String(bodyRaw || "").trim().toUpperCase();

  console.log("[twilio][inbound]", { from: fromRaw, body: bodyRaw });

  if (!from) {
    return res.status(200).send("OK");
  }

  if (STOP_WORDS.has(body)) {
    await prisma.pickupAppointment.updateMany({
      where: {
        OR: [{ smsOptInPhone: from }, { customerPhone: from }],
      },
      data: {
        smsOptIn: false,
        smsOptOutAt: new Date(),
        smsOptOutReason: body,
      },
    });

    await prisma.orderReadyNotice.updateMany({
      where: { contactPhone: from },
      data: {
        smsOptIn: false,
        smsOptOutAt: new Date(),
        smsOptOutReason: body,
      },
    });

    return res.status(200).send("OK");
  }

  if (START_WORDS.has(body)) {
    await prisma.pickupAppointment.updateMany({
      where: {
        OR: [{ smsOptInPhone: from }, { customerPhone: from }],
      },
      data: {
        smsOptIn: true,
        smsOptOutAt: null,
        smsOptOutReason: null,
      },
    });

    await prisma.orderReadyNotice.updateMany({
      where: { contactPhone: from },
      data: {
        smsOptIn: true,
        smsOptOutAt: null,
        smsOptOutReason: null,
      },
    });

    return res.status(200).send("OK");
  }

  return res.status(200).send("OK");
});
