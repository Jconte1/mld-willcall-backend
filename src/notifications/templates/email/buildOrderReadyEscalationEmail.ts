type EscalationInput = {
  orderNbr: string;
  customerId: string | null;
  customerName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  locationId: string | null;
  status: string | null;
  smsOptIn: boolean;
  emailOptIn: boolean;
  smsOptOutAt: Date | null;
  smsOptOutReason: string | null;
  notifyAttemptCount: number;
  lastNotifiedAt: Date | null;
};

function line(label: string, value: string) {
  return `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${label}</td><td style="padding:6px 0;color:#111827;font-size:13px;font-weight:600;">${value}</td></tr>`;
}

function asText(value: string | null | undefined) {
  const trimmed = String(value || "").trim();
  return trimmed || "Not set";
}

export function buildOrderReadyEscalationEmail(input: EscalationInput) {
  const subject = `Your customer for ${input.orderNbr} has not made an appointment`;
  const lastAttempt = input.lastNotifiedAt
    ? input.lastNotifiedAt.toLocaleString("en-US", { timeZone: "America/Denver" })
    : "Not set";

  const body = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${subject}</title>
  </head>
  <body style="margin:0;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td align="center" style="padding:24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:680px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
            <tr>
              <td style="padding:20px 24px;border-bottom:1px solid #e5e7eb;">
                <h1 style="margin:0 0 8px;font-size:20px;">${subject}</h1>
                <p style="margin:0;color:#374151;font-size:14px;">
                  This order has exceeded 5 outreach attempts without an appointment.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 24px;">
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                  ${line("Order Number", asText(input.orderNbr))}
                  ${line("Customer ID (BAID)", asText(input.customerId))}
                  ${line("Customer Name", asText(input.customerName))}
                  ${line("Contact Name", asText(input.contactName))}
                  ${line("Contact Email", asText(input.contactEmail))}
                  ${line("Contact Phone", asText(input.contactPhone))}
                  ${line("Location", asText(input.locationId))}
                  ${line("Order Status", asText(input.status))}
                  ${line("Attempt Count", String(input.notifyAttemptCount))}
                  ${line("Last Attempt (Denver)", lastAttempt)}
                  ${line("Email Opt-In", input.emailOptIn ? "Yes" : "No")}
                  ${line("SMS Opt-In", input.smsOptIn ? "Yes" : "No")}
                  ${line("SMS Opt-Out At", input.smsOptOutAt ? input.smsOptOutAt.toISOString() : "Not set")}
                  ${line("SMS Opt-Out Reason", asText(input.smsOptOutReason))}
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, body };
}
