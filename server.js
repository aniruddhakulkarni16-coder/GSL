const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { mongoose, cloudinary, Submission, Site } = require('./lib');
const { sendDecisionEmail } = require('./mailer');

const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !JWT_SECRET) {
  console.error('Missing ADMIN_USERNAME, ADMIN_PASSWORD or JWT_SECRET in .env');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https://res.cloudinary.com'],
        connectSrc: ["'self'"]
      }
    }
  })
);
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Not authorised' });
  }
}

const isId = (id) => mongoose.isValidObjectId(id);

/* ---------- validation helpers ---------- */
const NAME_RE = /^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+)*$/u; // letters and single spaces only
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[6-9]\d{9}$/; // valid Indian mobile number
const escapeRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Returns the 10-digit number from input typed as +91..., 91..., 0... or plain digits
function tenDigits(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

const formLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later' }
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later' }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP or GIF images are allowed'));
  }
});

/* Biodata upload (stored in MongoDB, max 2 MB) */
const ALLOWED_BIODATA = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png'
];
const biodataUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_BIODATA.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Biodata must be a PDF, DOC, DOCX, JPG or PNG file'));
  }
});
function handleBiodata(req, res, next) {
  biodataUpload.single('biodata')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Biodata file is too large (max 2 MB)' : err.message;
      return res.status(400).json({ error: msg });
    }
    next();
  });
}

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        {
          folder: 'gsl/sites',
          resource_type: 'image',
          transformation: [{ width: 1600, crop: 'limit' }]
        },
        (err, result) => (err ? reject(err) : resolve(result))
      )
      .end(buffer);
  });
}

/* ---------- public routes ---------- */
app.post('/api/submissions', formLimiter, handleBiodata, async (req, res) => {
  try {
    const b = req.body || {};
    if (!['hire', 'job'].includes(b.type)) return res.status(400).json({ error: 'Invalid form type' });

    // Name: letters and spaces only
    const name = String(b.name || '').replace(/\s+/g, ' ').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (name.length < 2 || name.length > 60 || !NAME_RE.test(name))
      return res.status(400).json({ error: 'Name can contain only letters and spaces' });

    // Phone: exactly 10 digits (Indian mobile), stored as +91XXXXXXXXXX
    const digits = tenDigits(b.phone);
    if (!digits) return res.status(400).json({ error: 'Phone number is required' });
    if (!PHONE_RE.test(digits))
      return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number' });

    // Email: required and must contain @
    const email = String(b.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required' });
    if (!email.includes('@') || !EMAIL_RE.test(email))
      return res.status(400).json({ error: 'Enter a valid email address (it must contain @)' });

    const doc = {
      type: b.type,
      name,
      phone: '+91' + digits,
      email,
      message: b.message || ''
    };
    if (b.type === 'hire') doc.service = b.service || '';
    if (b.type === 'job') {
      doc.position = b.position || '';
      const exp = parseFloat(b.experience);
      doc.experience = Number.isFinite(exp) ? exp : null;
      if (req.file) {
        doc.biodataName = req.file.originalname.slice(0, 150);
        doc.biodataType = req.file.mimetype;
        doc.biodataData = req.file.buffer;
      }
    }

    // Duplicate check: same type + same phone OR same email (any service / position)
    const dupQuery = {
      type: doc.type,
      $or: [
        { phone: { $in: ['+91' + digits, digits, '91' + digits] } },
        { email: new RegExp('^' + escapeRegex(email) + '$', 'i') }
      ]
    };
    const dup = await Submission.findOne(dupQuery).select('_id').lean();
    if (dup) {
      return res.status(409).json({
        error:
          doc.type === 'hire'
            ? 'An enquiry with this phone number or email has already been submitted. Our team will contact you soon.'
            : 'An application with this phone number or email has already been submitted. Our HR team will contact you soon.'
      });
    }

    await Submission.create(doc);
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ error: 'Please check your details and try again' });
    console.error(err);
    res.status(500).json({ error: 'Could not save your enquiry' });
  }
});

app.get('/api/sites', async (req, res) => {
  try {
    res.json(await Site.find().sort({ createdAt: 1 }).lean());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load sites' });
  }
});

/* ---------- admin routes ---------- */
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const ok = safeEqual(username || '', ADMIN_USERNAME) && safeEqual(password || '', ADMIN_PASSWORD);
  if (!ok) return res.status(401).json({ error: 'Incorrect username or password' });
  res.json({ token: jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '8h' }) });
});

app.get('/api/submissions', requireAdmin, async (req, res) => {
  try {
    res.json(await Submission.find().sort({ createdAt: -1 }).limit(200).lean());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load submissions' });
  }
});

app.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const [jobTotal, hireTotal, approved, rejected] = await Promise.all([
      Submission.countDocuments({ type: 'job' }),
      Submission.countDocuments({ type: 'hire' }),
      Submission.countDocuments({ type: 'job', status: 'approved' }),
      Submission.countDocuments({ type: 'job', status: 'rejected' })
    ]);

    // last 6 months, including the current one
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), job: 0, hire: 0 });
    }
    const start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const docs = await Submission.find({ createdAt: { $gte: start } }).select('type createdAt').lean();
    docs.forEach((d) => {
      const c = new Date(d.createdAt);
      const key = c.getFullYear() + '-' + String(c.getMonth() + 1).padStart(2, '0');
      const m = months.find((x) => x.key === key);
      if (m) m[d.type === 'job' ? 'job' : 'hire']++;
    });

    res.json({ jobTotal, hireTotal, approved, rejected, pending: jobTotal - approved - rejected, months });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load statistics' });
  }
});

app.patch('/api/submissions/:id/status', requireAdmin, async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  const status = (req.body || {}).status;
  if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    // new: false -> returns the application as it was BEFORE the change
    const before = await Submission.findOneAndUpdate({ _id: req.params.id }, { status }, { new: false }).lean();
    if (!before) return res.status(404).json({ error: 'Submission not found' });

    // Send an email only when the status really changes to approved / rejected
    let email = { sent: false, reason: '' };
    if (['approved', 'rejected'].includes(status) && (before.status || 'pending') !== status) {
      email = await sendDecisionEmail({
        to: before.email,
        name: before.name,
        position: before.position,
        service: before.service,
        type: before.type,
        decision: status
      });
    }
    res.json({ ok: true, status, emailSent: email.sent, emailNote: email.reason });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update status' });
  }
});

app.get('/api/submissions/:id/biodata', requireAdmin, async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const sub = await Submission.findById(req.params.id).select('+biodataData biodataName biodataType');
    if (!sub || !sub.biodataData) return res.status(404).json({ error: 'No biodata found' });
    res.setHeader('Content-Type', sub.biodataType || 'application/octet-stream');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(sub.biodataName || 'biodata'));
    res.send(sub.biodataData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load biodata' });
  }
});

app.delete('/api/submissions/:id', requireAdmin, async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const sub = await Submission.findById(req.params.id).select('type').lean();
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    if (sub.type === 'job') return res.status(403).json({ error: 'Job applications cannot be deleted' });
    await Submission.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete' });
  }
});

app.post('/api/sites', requireAdmin, (req, res) => {
  upload.single('photo')(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });
    try {
      const name = (req.body.name || '').trim();
      const loc = (req.body.loc || '').trim();
      if (!name || !loc) return res.status(400).json({ error: 'Name and location are required' });
      if (!req.file) return res.status(400).json({ error: 'Please choose a photo' });

      const result = await uploadToCloudinary(req.file.buffer);
      const site = await Site.create({
        name,
        loc,
        imageUrl: result.secure_url,
        publicId: result.public_id
      });
      res.status(201).json(site);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not upload the site' });
    }
  });
});

app.delete('/api/sites/:id', requireAdmin, async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const site = await Site.findByIdAndDelete(req.params.id);
    if (site && site.publicId) {
      await cloudinary.uploader.destroy(site.publicId).catch((e) => console.error('Cloudinary delete failed:', e.message));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('MongoDB Atlas connected: ' + mongoose.connection.name);
    app.listen(PORT, () => console.log(`GSL website running at http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Could not connect to MongoDB Atlas:', err.message);
    process.exit(1);
  });
