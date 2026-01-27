import { getGraphAccessToken } from "./graphClient";

type EmailResult = { ok: boolean; skipped?: boolean };
type SendEmailOptions = { allowTestOverride?: boolean; allowNonProdSend?: boolean };

function resolveRecipient(
  email: string,
  { allowTestOverride = true, allowNonProdSend = false }: SendEmailOptions = {}
) {
  // TODO: Revisit this behavior before production; allowNonProdSend is intended for local testing only.
  if (allowTestOverride && process.env.NOTIFICATIONS_TEST_EMAIL) {
    return process.env.NOTIFICATIONS_TEST_EMAIL;
  }
  if (process.env.NODE_ENV !== "production" && !allowNonProdSend) {
    return "";
  }
  return email;
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  options: SendEmailOptions = {}
): Promise<EmailResult> {
  const fromEmail = process.env.MS_GRAPH_FROM_EMAIL || "";
  const recipient = resolveRecipient(to, options);

  if (!recipient) {
    console.log("[notifications][email] skipped (no recipient)", { to });
    return { ok: true, skipped: true };
  }
  if (!fromEmail) {
    console.warn("[notifications][email] missing MS_GRAPH_FROM_EMAIL");
    throw new Error("MS_GRAPH_FROM_EMAIL is missing");
  }

  const token = await getGraphAccessToken();
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

  const resp = await fetch(url, {
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
