require('dotenv').config();
const nodemailer = require('nodemailer');

console.log('User:', process.env.SMTP_USER);
console.log('Password length:', (process.env.SMTP_PASS || '').length, '(should be 16)');

const t = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

t.verify()
  .then(() => console.log('LOGIN OK - Gmail accepted the username and password'))
  .catch((e) => console.log('LOGIN FAILED:', e.message));