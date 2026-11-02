require('dotenv').config();
const nodemailer = require('nodemailer');

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;

const COMPANY = 'GSL Security Services';
const COMPANY_PHONE = '02352-221007';
const COMPANY_EMAIL = 'gslsecurityservices@gmail.com';

let transporter = null;
if (SMTP_USER && SMTP_PASS) {
  const port = Number(SMTP_PORT) || 465;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
} else {
  console.warn('Email is not configured (SMTP_USER / SMTP_PASS missing in .env). Approval/rejection emails will be skipped.');
}

const esc = (t) =>
  String(t || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function buildMessage({ name, position, service, type, decision }) {
  if (type === 'hire') {
    const about = service ? ' for ' + service : '';
    if (decision === 'approved') {
      return {
        subject: 'Your enquiry has been approved - ' + COMPANY,
        text:
          `Dear ${name},\n\n` +
          `Thank you for contacting ${COMPANY}. Your service enquiry${about} has been approved.\n\n` +
          `Our team will contact you shortly to discuss your requirements and arrange the service. ` +
          `If you have any questions, you can call us on ${COMPANY_PHONE} or write to ${COMPANY_EMAIL}.\n\n` +
          `Warm regards,\nTeam ${COMPANY}`,
        heading: 'Enquiry Approved',
        body:
          `<p>Dear ${esc(name)},</p>` +
          `<p>Thank you for contacting ${COMPANY}. Your service enquiry${esc(about)} has been <strong style="color:#315D48;">approved</strong>.</p>` +
          `<p>Our team will contact you shortly to discuss your requirements and arrange the service.</p>`
      };
    }
    return {
      subject: 'Update on your enquiry - ' + COMPANY,
      text:
        `Dear ${name},\n\n` +
        `Thank you for contacting ${COMPANY} and for your interest in our services.\n\n` +
        `After reviewing your enquiry${about}, we are unable to take it up at this time. ` +
        `You are welcome to contact us again in the future.\n\n` +
        `If you have any questions, you can call us on ${COMPANY_PHONE} or write to ${COMPANY_EMAIL}.\n\n` +
        `Best wishes,\nTeam ${COMPANY}`,
      heading: 'Enquiry Update',
      body:
        `<p>Dear ${esc(name)},</p>` +
        `<p>Thank you for contacting ${COMPANY} and for your interest in our services.</p>` +
        `<p>After reviewing your enquiry${esc(about)}, we are unable to take it up at this time. ` +
        `You are welcome to contact us again in the future.</p>`
    };
  }

  const role = position ? ' for the position of ' + position : '';
  if (decision === 'approved') {
    return {
      subject: 'Your application has been approved - ' + COMPANY,
      text:
        `Dear ${name},\n\n` +
        `Congratulations! Your job application${role} at ${COMPANY} has been approved.\n\n` +
        `Our HR team will contact you shortly with the next steps. ` +
        `If you have any questions, you can call us on ${COMPANY_PHONE} or write to ${COMPANY_EMAIL}.\n\n` +
        `Warm regards,\nHR Team\n${COMPANY}`,
      heading: 'Application Approved',
      body:
        `<p>Dear ${esc(name)},</p>` +
        `<p><strong>Congratulations!</strong> Your job application${esc(role)} at ${COMPANY} has been <strong style="color:#315D48;">approved</strong>.</p>` +
        `<p>Our HR team will contact you shortly with the next steps.</p>`
    };
  }
  return {
    subject: 'Update on your application - ' + COMPANY,
    text:
      `Dear ${name},\n\n` +
      `Thank you for your interest in ${COMPANY} and for taking the time to apply${role}.\n\n` +
      `After careful review, we are unable to move forward with your application at this time. ` +
      `We will keep your details in mind for future openings, and you are welcome to apply again later.\n\n` +
      `If you have any questions, you can call us on ${COMPANY_PHONE} or write to ${COMPANY_EMAIL}.\n\n` +
      `Best wishes,\nHR Team\n${COMPANY}`,
    heading: 'Application Update',
    body:
      `<p>Dear ${esc(name)},</p>` +
      `<p>Thank you for your interest in ${COMPANY} and for taking the time to apply${esc(role)}.</p>` +
      `<p>After careful review, we are unable to move forward with your application at this time. ` +
      `We will keep your details in mind for future openings, and you are welcome to apply again later.</p>`
  };
}

function wrapHtml(heading, body, signoff) {
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;border:1px solid #e3e6ef;border-radius:10px;overflow:hidden;">` +
    `<div style="background:#1B2A5E;color:#fff;padding:18px 24px;font-size:18px;font-weight:bold;">${COMPANY}</div>` +
    `<div style="padding:24px;color:#2B2B2B;font-size:15px;line-height:1.6;">` +
    `<h2 style="margin:0 0 14px;color:#1B2A5E;font-size:20px;">${heading}</h2>` +
    body +
    `<p>For any questions, call us on <strong>${COMPANY_PHONE}</strong> or write to ` +
    `<a href="mailto:${COMPANY_EMAIL}" style="color:#1B2A5E;">${COMPANY_EMAIL}</a>.</p>` +
    `<p style="margin-bottom:0;">Regards,<br><strong>${signoff}</strong><br>${COMPANY}</p>` +
    `</div></div>`
  );
}

// Returns { sent: boolean, reason: string }. Never throws, so a mail problem cannot break the admin action.
async function sendDecisionEmail({ to, name, position, service, type, decision }) {
  if (!to) return { sent: false, reason: 'This submission has no email address.' };
  if (!transporter) return { sent: false, reason: 'Email is not set up on the server (.env).' };
  try {
    const m = buildMessage({ name, position, service, type, decision });
    await transporter.sendMail({
      from: MAIL_FROM || `"${COMPANY}" <${SMTP_USER}>`,
      to,
      subject: m.subject,
      text: m.text,
      html: wrapHtml(m.heading, m.body, type === 'hire' ? 'Team ' + COMPANY : 'HR Team')
    });
    return { sent: true, reason: '' };
  } catch (err) {
    console.error('Email sending failed:', err.message);
    return { sent: false, reason: 'The email service returned an error. Check the server log.' };
  }
}

module.exports = { sendDecisionEmail };
