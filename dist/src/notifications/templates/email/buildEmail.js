"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildEmailMessage = buildEmailMessage;
const client_1 = require("@prisma/client");
const format_1 = require("../../format");
const BRAND_NAME = "MLD Will Call";
const BRAND_COLOR = "#111827";
const ACCENT_COLOR = "#0f766e";
function formatOrderList(orderNbrs = []) {
    if (!orderNbrs.length)
        return "(none)";
    return orderNbrs.join(", ");
}
function renderTemplate({ title, preheader, message, when, orders, link, unsubscribeLink, staffNote, }) {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</span>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td align="center" style="padding:24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 25px rgba(17,24,39,0.08);">
            <tr>
              <td style="padding:24px 28px;background:#f9fafb;border-bottom:1px solid #e5e7eb;">
                <div style="font-size:18px;font-weight:700;color:${BRAND_COLOR};">${BRAND_NAME}</div>
                <div style="font-size:12px;color:#6b7280;margin-top:4px;">Pickup appointment update</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${BRAND_COLOR};">${title}</h1>
                <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151;">${message}</p>
                ${staffNote ? `<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#6b7280;">${staffNote}</p>` : ""}

                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:20px;">
                  <tr>
                    <td style="font-size:13px;color:#6b7280;padding-bottom:6px;">Appointment</td>
                  </tr>
                  <tr>
                    <td style="font-size:16px;font-weight:600;color:${BRAND_COLOR};padding-bottom:8px;">${when}</td>
                  </tr>
                  <tr>
                    <td style="font-size:13px;color:#6b7280;">Orders</td>
                  </tr>
                  <tr>
                    <td style="font-size:14px;color:#374151;">${orders}</td>
                  </tr>
                </table>

                <a href="${link}" style="display:inline-block;background:${ACCENT_COLOR};color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-size:14px;font-weight:600;">Manage appointment</a>

                <p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#6b7280;">
                  This link is secure and can be used to view or update your appointment.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 28px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
                If you did not request this, you can ignore this email.
                ${unsubscribeLink ? `<div style="margin-top:10px;"><a href="${unsubscribeLink}" style="color:#6b7280;text-decoration:underline;">Unsubscribe from email updates</a></div>` : ""}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
function buildEmailMessage(type, payload) {
    const when = (0, format_1.formatDenverDateTime)(payload.startAt);
    const orders = formatOrderList(payload.orderNbrs);
    const staffNote = payload.staffInitiated
        ? "This update was made by our staff to keep your pickup on track."
        : undefined;
    switch (type) {
        case client_1.AppointmentNotificationType.ScheduledConfirm:
            return {
                subject: "Pickup scheduled",
                body: renderTemplate({
                    title: "Pickup scheduled",
                    preheader: `Your pickup is scheduled for ${when}.`,
                    message: `Your pickup appointment is confirmed for ${when}.`,
                    when,
                    orders,
                    link: payload.link,
                    unsubscribeLink: payload.unsubscribeLink,
                    staffNote,
                }),
            };
        case client_1.AppointmentNotificationType.Reminder1Day:
            return {
                subject: "Pickup reminder (1 day)",
                body: renderTemplate({
                    title: "Pickup reminder",
                    preheader: `Reminder: your pickup is tomorrow at ${when}.`,
                    message: `Reminder: your pickup is scheduled for tomorrow at ${when}.`,
                    when,
                    orders,
                    link: payload.link,
                    unsubscribeLink: payload.unsubscribeLink,
                    staffNote,
                }),
            };
        case client_1.AppointmentNotificationType.Reminder1Hour:
            return {
                subject: "Pickup reminder (1 hour)",
                body: renderTemplate({
                    title: "Pickup reminder",
                    preheader: `Your pickup is in 1 hour at ${when}.`,
                    message: `Reminder: your pickup is in one hour at ${when}.`,
                    when,
                    orders,
                    link: payload.link,
                    unsubscribeLink: payload.unsubscribeLink,
                    staffNote,
                }),
            };
        case client_1.AppointmentNotificationType.Rescheduled: {
            const oldWhen = payload.oldStartAt ? (0, format_1.formatDenverDateTime)(payload.oldStartAt) : "previous time";
            return {
                subject: "Pickup rescheduled",
                body: renderTemplate({
                    title: "Pickup rescheduled",
                    preheader: `Your pickup moved from ${oldWhen} to ${when}.`,
                    message: `Your pickup was rescheduled from ${oldWhen} to ${when}.`,
                    when,
                    orders,
                    link: payload.link,
                    unsubscribeLink: payload.unsubscribeLink,
                    staffNote,
                }),
            };
        }
        case client_1.AppointmentNotificationType.Cancelled: {
            const reason = payload.cancelReason ? `Reason: ${payload.cancelReason}\n` : "";
            return {
                subject: "Pickup cancelled",
                body: renderTemplate({
                    title: "Pickup cancelled",
                    preheader: `Your pickup on ${when} was cancelled.`,
                    message: `Your pickup scheduled for ${when} was cancelled.${payload.cancelReason ? ` Reason: ${payload.cancelReason}.` : ""}`,
                    when,
                    orders,
                    link: payload.link,
                    unsubscribeLink: payload.unsubscribeLink,
                    staffNote,
                }),
            };
        }
        case client_1.AppointmentNotificationType.Completed:
            return {
                subject: "Pickup completed",
                body: renderTemplate({
                    title: "Pickup completed",
                    preheader: `Your pickup for ${when} is marked complete.`,
                    message: `Your pickup appointment for ${when} is marked complete.`,
                    when,
                    orders,
                    link: payload.link,
                    unsubscribeLink: payload.unsubscribeLink,
                    staffNote,
                }),
            };
        case client_1.AppointmentNotificationType.OrderListChanged:
            return {
                subject: "Pickup orders updated",
                body: renderTemplate({
                    title: "Pickup orders updated",
                    preheader: "Your pickup order list has been updated.",
                    message: "Your pickup order list has been updated. Please review the orders below.",
                    when,
                    orders,
                    link: payload.link,
                    unsubscribeLink: payload.unsubscribeLink,
                    staffNote,
                }),
            };
        default:
            return {
                subject: "Pickup update",
                body: renderTemplate({
                    title: "Pickup update",
                    preheader: `Pickup update for ${when}.`,
                    message: `There is an update to your pickup appointment for ${when}.`,
                    when,
                    orders,
                    link: payload.link,
                    unsubscribeLink: payload.unsubscribeLink,
                    staffNote,
                }),
            };
    }
}
