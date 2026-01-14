"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmail = sendEmail;
const node_fetch_1 = __importDefault(require("node-fetch"));
const graphClient_1 = require("./graphClient");
function resolveRecipient(email) {
    if (process.env.NODE_ENV !== "production") {
        return process.env.NOTIFICATIONS_TEST_EMAIL || "";
    }
    return email;
}
async function sendEmail(to, subject, body) {
    const fromEmail = process.env.MS_GRAPH_FROM_EMAIL || "";
    const recipient = resolveRecipient(to);
    if (!recipient) {
        console.log("[notifications][email] skipped (no recipient)", { to });
        return { ok: true, skipped: true };
    }
    if (!fromEmail) {
        console.warn("[notifications][email] missing MS_GRAPH_FROM_EMAIL");
        throw new Error("MS_GRAPH_FROM_EMAIL is missing");
    }
    const token = await (0, graphClient_1.getGraphAccessToken)();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`;
    const payload = {
        message: {
            subject,
            body: {
                contentType: "HTML",
                content: body,
            },
            toRecipients: [{ emailAddress: { address: recipient } }],
        },
        saveToSentItems: true,
    };
    const resp = await (0, node_fetch_1.default)(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });
    if (!resp.ok) {
        const text = await resp.text();
        console.error("[notifications][email] send failed", resp.status, text);
        throw new Error(`Graph sendMail failed: ${resp.status} ${text}`);
    }
    console.log("[notifications][email] sent", { to: recipient });
    return { ok: true };
}
