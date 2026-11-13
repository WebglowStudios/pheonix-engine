/**
 * emailService.js
 * Centralised Nodemailer email service for Phoenix Finance.
 *
 * Emails sent:
 *  - Admin: new enquiry / lead notification
 *  - User:  enquiry received confirmation
 *  - User:  welcome / account created
 *  - Admin: new user registered notification
 *
 * Setup:  Add these to your .env file:
 *   SMTP_HOST=smtp.hostinger.com
 *   SMTP_PORT=465
 *   SMTP_SECURE=true
 *   SMTP_USER=chirag@phoenixfiserv.co.in
 *   SMTP_PASS=your_password
 *   SMTP_FROM=connect@phoenixfiserv.co.in
 *   ADMIN_EMAIL=connect@phoenixfiserv.co.in
 */

const nodemailer = require("nodemailer");

// ── Transporter (created lazily so missing env vars don't crash server boot) ──
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("[Email] SMTP_USER / SMTP_PASS not set — emails disabled.");
    return null;
  }

  _transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || "smtp.hostinger.com",
    port:   parseInt(process.env.SMTP_PORT || "465", 10),
    secure: process.env.SMTP_SECURE !== "false",   // defaults true for port 465
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { rejectUnauthorized: false },
  });

  return _transporter;
}

// ── Core send helper ──────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html, text }) {
  const transporter = getTransporter();
  if (!transporter) return { sent: false, reason: "Email not configured" };

  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || `"Phoenix Financial Services" <${process.env.SMTP_USER}>`,
      to,
      subject,
      text: text || subject,
      html,
    });
    console.log(`[Email] Sent → ${to} | ${subject} | id: ${info.messageId}`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Email] Failed → ${to} | ${subject} |`, err.message);
    return { sent: false, reason: err.message };
  }
}

// ── Shared HTML wrapper ───────────────────────────────────────────────────────
function wrapHtml(title, bodyHtml) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    body { margin:0; padding:0; background:#f4f6f9; font-family: 'Segoe UI', Arial, sans-serif; }
    .wrap { max-width:600px; margin:30px auto; background:#ffffff; border-radius:10px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,.08); }
    .header { background: linear-gradient(135deg,#1a2740 0%,#243352 100%); padding:28px 32px; }
    .header h1 { color:#f0a500; margin:0; font-size:22px; letter-spacing:.5px; }
    .header p  { color:#a0aec0; margin:4px 0 0; font-size:13px; }
    .body   { padding:32px; color:#2d3748; font-size:15px; line-height:1.7; }
    .body h2 { font-size:18px; color:#1a2740; margin-top:0; }
    .info-box { background:#f7fafc; border-left:4px solid #f0a500; padding:14px 18px; border-radius:4px; margin:18px 0; }
    .info-box table { width:100%; border-collapse:collapse; }
    .info-box td   { padding:4px 0; font-size:14px; vertical-align:top; }
    .info-box td:first-child { color:#718096; width:38%; font-weight:600; }
    .btn { display:inline-block; margin:20px 0 0; background:#f0a500; color:#1a2740 !important; padding:11px 28px; border-radius:6px; text-decoration:none; font-weight:700; font-size:14px; }
    .footer { background:#f7fafc; border-top:1px solid #e2e8f0; padding:18px 32px; font-size:12px; color:#a0aec0; text-align:center; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <h1>🦅 Phoenix Finance</h1>
      <p>${title}</p>
    </div>
    <div class="body">${bodyHtml}</div>
    <div class="footer">
      © ${new Date().getFullYear()} Phoenix Finance &nbsp;|&nbsp;
      This is an automated message, please do not reply.
    </div>
  </div>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. NEW ENQUIRY — Admin alert
// ═══════════════════════════════════════════════════════════════════════════════
async function sendEnquiryAdminAlert(lead) {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.MAIL_USER;
  const html = wrapHtml(
    "New Enquiry Received",
    `
    <h2>📬 New Enquiry from ${lead.name}</h2>
    <p>Someone just submitted a contact form on the website. Here are the details:</p>
    <div class="info-box">
      <table>
        <tr><td>Name</td><td><strong>${lead.name}</strong></td></tr>
        <tr><td>Phone</td><td>${lead.phone}</td></tr>
        <tr><td>Email</td><td>${lead.email || "—"}</td></tr>
        <tr><td>Services</td><td>${Array.isArray(lead.services) && lead.services.length ? lead.services.join(", ") : "—"}</td></tr>
        <tr><td>Best Time</td><td>${lead.connect_time || "—"}</td></tr>
        <tr><td>Source</td><td>${lead.source || "contact_page"}</td></tr>
        <tr><td>Message</td><td>${lead.message || "—"}</td></tr>
        <tr><td>Received At</td><td>${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</td></tr>
      </table>
    </div>
    <p>Log in to the admin panel to view and follow up on this lead.</p>
    `
  );

  return sendEmail({
    to: adminEmail,
    subject: `📬 New Enquiry: ${lead.name} (${lead.phone})`,
    html,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. ENQUIRY RECEIVED — User confirmation
// ═══════════════════════════════════════════════════════════════════════════════
async function sendEnquiryUserConfirmation(lead) {
  if (!lead.email) return { sent: false, reason: "No user email provided" };

  const html = wrapHtml(
    "We received your enquiry",
    `
    <h2>Hi ${lead.name},</h2>
    <p>Thank you for reaching out to <strong>Phoenix Finance</strong>! 🎉</p>
    <p>We have received your enquiry and our team will get back to you within <strong>24–48 hours</strong>.</p>
    <div class="info-box">
      <table>
        <tr><td>Your Name</td><td>${lead.name}</td></tr>
        <tr><td>Phone</td><td>${lead.phone}</td></tr>
        ${lead.services && lead.services.length ? `<tr><td>Services</td><td>${lead.services.join(", ")}</td></tr>` : ""}
        ${lead.connect_time ? `<tr><td>Preferred Time</td><td>${lead.connect_time}</td></tr>` : ""}
      </table>
    </div>
    <p>In the meantime, feel free to explore our website or call us directly for urgent matters.</p>
    <p style="margin-top:24px;">Warm regards,<br/><strong>Team Phoenix Finance</strong></p>
    `
  );

  return sendEmail({
    to: lead.email,
    subject: "✅ We received your enquiry — Phoenix Finance",
    html,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. WELCOME EMAIL — User account created
// ═══════════════════════════════════════════════════════════════════════════════
async function sendWelcomeEmail(user) {
  if (!user.email) return { sent: false, reason: "No user email" };

  const html = wrapHtml(
    "Welcome to Phoenix Finance",
    `
    <h2>Welcome, ${user.name}! 🎊</h2>
    <p>Your <strong>Phoenix Finance</strong> account has been successfully created.</p>
    <p>You can now log in to your personal investment dashboard to:</p>
    <ul style="line-height:2">
      <li>📊 Track all your investments in one place</li>
      <li>📈 Monitor live portfolio performance</li>
      <li>💰 View your P&amp;L, gains, and transaction history</li>
      <li>📁 Access detailed reports for each holding</li>
    </ul>
    <div class="info-box">
      <table>
        <tr><td>Name</td><td>${user.name}</td></tr>
        <tr><td>Email</td><td>${user.email}</td></tr>
        ${user.phone ? `<tr><td>Phone</td><td>${user.phone}</td></tr>` : ""}
        <tr><td>Account Created</td><td>${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</td></tr>
      </table>
    </div>
    <p>If you did not create this account, please contact us immediately.</p>
    <p style="margin-top:24px;">Warm regards,<br/><strong>Team Phoenix Finance</strong></p>
    `
  );

  return sendEmail({
    to: user.email,
    subject: "🎊 Welcome to Phoenix Finance — Your account is ready",
    html,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. NEW USER REGISTERED — Admin alert
// ═══════════════════════════════════════════════════════════════════════════════
async function sendNewUserAdminAlert(user) {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.MAIL_USER;

  const html = wrapHtml(
    "New User Registered",
    `
    <h2>👤 New User Registered</h2>
    <p>A new user has just created an account on Phoenix Finance.</p>
    <div class="info-box">
      <table>
        <tr><td>Name</td><td><strong>${user.name}</strong></td></tr>
        <tr><td>Email</td><td>${user.email}</td></tr>
        <tr><td>Phone</td><td>${user.phone || "—"}</td></tr>
        <tr><td>Risk Profile</td><td>${user.riskProfile || "—"}</td></tr>
        <tr><td>Registered At</td><td>${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</td></tr>
      </table>
    </div>
    <p>Log in to the admin panel to set up their portfolio and assign investments.</p>
    `
  );

  return sendEmail({
    to: adminEmail,
    subject: `👤 New User: ${user.name} (${user.email})`,
    html,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. PASSWORD RESET — Email with reset link
// ═══════════════════════════════════════════════════════════════════════════════
async function sendPasswordResetEmail(user, resetToken) {
  if (!user.email) return { sent: false, reason: "No user email" };

  const siteUrl = (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/$/, "");
  const resetUrl = `${siteUrl}/reset-password/${resetToken}`;

  const html = wrapHtml(
    "Password Reset Request",
    `
    <h2>Reset Your Password</h2>
    <p>Hi <strong>${user.name}</strong>,</p>
    <p>We received a request to reset your Phoenix Finance account password. Click the button below to set a new password:</p>
    <div style="text-align:center;">
      <a href="${resetUrl}" class="btn">🔐 Reset My Password</a>
    </div>
    <div class="info-box" style="margin-top:24px;">
      <table>
        <tr><td>Link expires in</td><td><strong>1 hour</strong></td></tr>
        <tr><td>Requested at</td><td>${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</td></tr>
      </table>
    </div>
    <p style="margin-top:20px; font-size:13px; color:#718096;">
      If the button doesn't work, copy and paste this link into your browser:<br/>
      <a href="${resetUrl}" style="color:#f0a500; word-break:break-all;">${resetUrl}</a>
    </p>
    <p style="font-size:13px; color:#718096;">
      If you did not request a password reset, please ignore this email — your password will remain unchanged.
    </p>
    `
  );

  return sendEmail({
    to: user.email,
    subject: "🔐 Reset your Phoenix Finance password",
    html,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. ADMIN CREATED ACCOUNT — Email user their credentials
// ═══════════════════════════════════════════════════════════════════════════════
async function sendAdminCreatedAccountEmail(user, temporaryPassword) {
  if (!user.email) return { sent: false, reason: "No user email" };

  const siteUrl = (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/$/, "");
  const loginUrl = `${siteUrl}/login`;

  const html = wrapHtml(
    "Your account has been created",
    `
    <h2>Welcome to Phoenix Finance, ${user.name}! 🎊</h2>
    <p>Your investment portal account has been created by our team. Here are your login credentials:</p>
    <div class="info-box">
      <table>
        <tr><td>Portal URL</td><td><a href="${loginUrl}" style="color:#f0a500;">${loginUrl}</a></td></tr>
        <tr><td>Email</td><td><strong>${user.email}</strong></td></tr>
        <tr><td>Temporary Password</td><td><strong style="font-size:16px; letter-spacing:1px;">${temporaryPassword}</strong></td></tr>
      </table>
    </div>
    <div style="text-align:center;">
      <a href="${loginUrl}" class="btn">🚀 Login to My Portfolio</a>
    </div>
    <p style="margin-top:24px; font-size:13px; color:#718096;">
      ⚠️ For your security, please change your password after logging in for the first time.<br/>
      Go to <strong>Dashboard → Settings → Change Password</strong>.
    </p>
    <p style="font-size:13px; color:#718096;">
      If you have any trouble logging in, reply to this email or contact us directly.
    </p>
    <p style="margin-top:24px;">Warm regards,<br/><strong>Team Phoenix Finance</strong></p>
    `
  );

  return sendEmail({
    to: user.email,
    subject: "🎊 Your Phoenix Finance account is ready — Login details inside",
    html,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════════
module.exports = {
  sendEmail,
  sendEnquiryAdminAlert,
  sendEnquiryUserConfirmation,
  sendWelcomeEmail,
  sendNewUserAdminAlert,
  sendPasswordResetEmail,
  sendAdminCreatedAccountEmail,
};

