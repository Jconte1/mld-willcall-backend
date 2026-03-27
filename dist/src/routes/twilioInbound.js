"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.twilioInboundRouter = void 0;
const express_1 = require("express");
const prisma_1 = require("../lib/prisma");
exports.twilioInboundRouter = (0, express_1.Router)();
const STOP_WORDS = new Set(["STOP", "STOPALL", "END", "CANCEL", "UNSUBSCRIBE", "QUIT"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES"]);
function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    return digits || null;
}
exports.twilioInboundRouter.post("/inbound", async (req, res) => {
    const fromRaw = req.body?.From;
    const bodyRaw = req.body?.Body;
    const from = normalizePhone(fromRaw);
    const body = String(bodyRaw || "").trim().toUpperCase();
    console.log("[twilio][inbound]", { from: fromRaw, body: bodyRaw });
    if (!from) {
        return res.status(200).send("OK");
    }
    if (STOP_WORDS.has(body)) {
        await prisma_1.prisma.pickupAppointment.updateMany({
            where: {
                OR: [{ smsOptInPhone: from }, { customerPhone: from }],
            },
            data: {
                smsOptIn: false,
                smsOptOutAt: new Date(),
                smsOptOutReason: body,
            },
        });
        await prisma_1.prisma.orderReadyNotice.updateMany({
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
        await prisma_1.prisma.pickupAppointment.updateMany({
            where: {
                OR: [{ smsOptInPhone: from }, { customerPhone: from }],
            },
            data: {
                smsOptIn: true,
                smsOptOutAt: null,
                smsOptOutReason: null,
            },
        });
        await prisma_1.prisma.orderReadyNotice.updateMany({
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
