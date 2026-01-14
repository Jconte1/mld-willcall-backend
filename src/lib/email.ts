import nodemailer from "nodemailer";

export function getMailer() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? "587");
  const user = process.env.AUTO_EMAIL;
  const pass = process.env.AUTO_EMAIL_PASSWORD;

  if (!host || !user || !pass) {
    throw new Error("Missing SMTP env vars: SMTP_HOST, AUTO_EMAIL, AUTO_EMAIL_PASSWORD");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  resetUrl: string;
}) {
  const appName = process.env.APP_NAME ?? "MLD WillCall";
  const from = process.env.AUTO_EMAIL;
  if (!from) throw new Error("AUTO_EMAIL not set");

  const transport = getMailer();

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.4;">
      <h2 style="margin: 0 0 12px;">Reset your password</h2>
      <p style="margin: 0 0 12px;">
        A password reset was requested for your ${appName} staff account.
      </p>
      <p style="margin: 0 0 12px;">
        This link expires in <b>1 hour</b>.
      </p>
      <p style="margin: 0 0 18px;">
        <a href="${opts.resetUrl}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#111;color:#fff;text-decoration:none;">
          Reset Password
        </a>
      </p>
      <p style="margin: 0; color: #555;">
        If you didn't request this, you can ignore this email.
      </p>
    </div>
  `;

  await transport.sendMail({
    from,
    to: opts.to,
    subject: `${appName} — Password Reset`,
    html
  });
}
