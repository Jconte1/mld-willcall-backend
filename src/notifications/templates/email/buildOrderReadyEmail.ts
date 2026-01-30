const BRAND_NAME = "MLD Will Call";
const BRAND_COLOR = "#111827";
const ACCENT_COLOR = "#dbaa3c";
const OUTER_BG = "#f8f2e9";

function renderOrderReadyTemplate({
  title,
  preheader,
  message,
  orderNbr,
  link,
  logoUrl,
}: {
  title: string;
  preheader: string;
  message: string;
  orderNbr: string;
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
                <div style="font-size:12px;color:#6b7280;margin-top:4px;">Order ready for pickup</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${BRAND_COLOR};">${title}</h1>
                <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151;">${message}</p>

                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:20px;">
                  <tr>
                    <td style="font-size:13px;color:#6b7280;padding-bottom:6px;">Order</td>
                  </tr>
                  <tr>
                    <td style="font-size:16px;font-weight:600;color:${BRAND_COLOR};">${orderNbr}</td>
                  </tr>
                </table>

                <a href="${link}" style="display:inline-block;background:${ACCENT_COLOR};color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-size:14px;font-weight:600;">Schedule pickup</a>

                <p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#6b7280;">
                  This link is secure and can be used to schedule your pickup.
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

export function buildOrderReadyEmail(orderNbr: string, link: string) {
  const frontendUrl = (process.env.FRONTEND_URL || "https://mld-willcall.vercel.app").replace(/\/$/, "");
  const logoUrl = `${frontendUrl}/brand/MLD-logo-gold.png`;
  return {
    subject: `Order ${orderNbr} is ready to schedule pickup`,
    body: renderOrderReadyTemplate({
      title: "Your order is ready for pickup",
      preheader: `Order ${orderNbr} is ready for pickup.`,
      message: `Your order ${orderNbr} is ready for pickup. Schedule a pickup time when it works best for you.`,
      orderNbr,
      link,
      logoUrl,
    }),
  };
}
