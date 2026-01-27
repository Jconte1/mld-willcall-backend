"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildStaffOnboardingEmail = buildStaffOnboardingEmail;
const BRAND_NAME = "MLD Will Call";
const BRAND_COLOR = "#111827";
const ACCENT_COLOR = "#0f766e";
function renderStaffOnboardingTemplate({ title, preheader, name, loginUrl, tempPassword, }) {
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
                <div style="font-size:12px;color:#6b7280;margin-top:4px;">Staff access</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${BRAND_COLOR};">${title}</h1>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">
                  Hi ${name}, your staff account has been created. Use the temporary password below to sign in.
                </p>

                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:20px;">
                  <tr>
                    <td style="font-size:13px;color:#6b7280;padding-bottom:6px;">Temporary password</td>
                  </tr>
                  <tr>
                    <td style="font-size:18px;font-weight:700;color:${BRAND_COLOR};letter-spacing:0.5px;">${tempPassword}</td>
                  </tr>
                </table>

                <a href="${loginUrl}" style="display:inline-block;background:${ACCENT_COLOR};color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-size:14px;font-weight:600;">Sign in to staff</a>

                <p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#6b7280;">
                  You will be required to change your password the first time you sign in.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 28px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
                If you did not expect this email, please contact your administrator.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
function buildStaffOnboardingEmail(name, loginUrl, tempPassword) {
    const safeName = name?.trim() || "there";
    return {
        subject: "Your MLD Will Call staff access",
        body: renderStaffOnboardingTemplate({
            title: "Your staff account is ready",
            preheader: "Your MLD Will Call staff account is ready.",
            name: safeName,
            loginUrl,
            tempPassword,
        }),
    };
}
