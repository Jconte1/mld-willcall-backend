const BRAND_NAME = "MLD Will Call";
const BRAND_COLOR = "#111827";
const ACCENT_COLOR = "#dbaa3c";
const OUTER_BG = "#f8f2e9";

function renderNoShowTemplate({
  title,
  preheader,
  message,
  when,
  orders,
  link,
  logoUrl,
}: {
  title: string;
  preheader: string;
  message: string;
  when: string;
  orders: string;
  link: string;
  logoUrl: string;
}) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="margin:0;background:${OUTER_BG};font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</span>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td align="center" style="padding:24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 25px rgba(17,24,39,0.08);">
            <tr>
              <td style="padding:24px 28px;background:#f9fafb;border-bottom:1px solid #e5e7eb;text-align:center;">
                <div style="margin-bottom:8px;">
                  <img src="${logoUrl}" alt="MLD" style="height:32px;display:block;margin:0 auto;" />
                </div>
                <div style="font-size:18px;font-weight:700;color:${BRAND_COLOR};">${BRAND_NAME}</div>
                <div style="font-size:12px;color:#6b7280;margin-top:4px;">Pickup appointment update</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${BRAND_COLOR};">${title}</h1>
                <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151;">${message}</p>

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

                <a href="${link}" style="display:inline-block;background:${ACCENT_COLOR};color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-size:14px;font-weight:600;">Reschedule pickup</a>

                <p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#6b7280;">
                  This link is secure and can be used to reschedule your pickup.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 28px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
                If you did not request this, you can ignore this email.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function buildNoShowEmail(when: string, orders: string, link: string) {
  const frontendUrl = (process.env.FRONTEND_URL || "https://mld-willcall.vercel.app").replace(/\/$/, "");
  const logoUrl = `${frontendUrl}/brand/MLD-logo-gold.png`;
  return {
    subject: "We missed you at pickup",
    body: renderNoShowTemplate({
      title: "We missed you",
      preheader: `We missed you at your pickup on ${when}.`,
      message: `We didn't see you at your pickup scheduled for ${when}. Your product is being returned to stock, so please reschedule as soon as possible.`,
      when,
      orders,
      link,
      logoUrl,
    }),
  };
}
