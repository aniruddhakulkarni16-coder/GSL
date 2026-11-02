require('dotenv').config();
const mongoose = require('mongoose');
const { v2: cloudinary } = require('cloudinary');

const required = ['MONGODB_URI', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('Missing values in .env: ' + missing.join(', '));
  process.exit(1);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const submissionSchema = new mongoose.Schema({
  type: { type: String, enum: ['hire', 'job'], required: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  phone: { type: String, required: true, trim: true, maxlength: 30 },
  email: { type: String, trim: true, maxlength: 160, default: '' },
  service: { type: String, trim: true, maxlength: 80, default: '' },
  position: { type: String, trim: true, maxlength: 80, default: '' },
  experience: { type: Number, min: 0, max: 60, default: null },
  message: { type: String, trim: true, maxlength: 2000, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  biodataName: { type: String, trim: true, maxlength: 150, default: '' },
  biodataType: { type: String, default: '' },
  biodataData: { type: Buffer, select: false },
  createdAt: { type: Date, default: Date.now }
});

const siteSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  loc: { type: String, required: true, trim: true, maxlength: 80 },
  imageUrl: { type: String, required: true },
  publicId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const Submission = mongoose.model('Submission', submissionSchema);
const Site = mongoose.model('Site', siteSchema);

module.exports = { mongoose, cloudinary, Submission, Site };
