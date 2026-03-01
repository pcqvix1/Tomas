const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const https = require('https');
const path = require('path');
const { v2: cloudinary } = require('cloudinary');

if (process.env.NODE_ENV !== 'production') {
  try {
    require('dotenv').config({ quiet: true });
  } catch {
    // dotenv is optional in production/serverless
  }
}

// =============================================
//  🎂 CONFIGURAÇÃO — EDITE AQUI!
// =============================================
const CONFIG = {
  nome: 'Tomás',
  idade: 2,
  mensagem: 'Tire fotos e compartilhe os melhores momentos! 🎉',
};
// =============================================

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = process.cwd();
const VIEWS_DIR = path.join(ROOT_DIR, 'views');
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'fotos-festa';

const cloudinaryConfigured = Boolean(
  process.env.CLOUDINARY_URL ||
    (process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET)
);

if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Só imagens!'));
  },
});

function ensureCloudinary(req, res, next) {
  if (!cloudinaryConfigured) {
    return res.status(500).json({
      error:
        'Cloudinary não configurado. Defina CLOUDINARY_URL ou CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET.',
    });
  }
  return next();
}

function uploadBufferToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const publicId = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

    const stream = cloudinary.uploader.upload_stream(
      {
        folder: CLOUDINARY_FOLDER,
        resource_type: 'image',
        public_id: publicId,
      },
      (err, result) => {
        if (err) return reject(err);
        return resolve(result);
      }
    );

    stream.end(file.buffer);
  });
}

async function listAllPhotos() {
  const items = [];
  let nextCursor;

  do {
    const page = await cloudinary.api.resources({
      type: 'upload',
      resource_type: 'image',
      prefix: `${CLOUDINARY_FOLDER}/`,
      max_results: 500,
      next_cursor: nextCursor,
    });

    items.push(...(page.resources || []));
    nextCursor = page.next_cursor;
  } while (nextCursor);

  return items
    .map((r) => ({
      arquivo: r.public_id.split('/').pop(),
      url: r.secure_url,
      data: r.created_at,
    }))
    .sort((a, b) => new Date(b.data) - new Date(a.data));
}

// — Páginas —
app.get('/', (_, res) => res.sendFile(path.join(VIEWS_DIR, 'upload.html')));
app.get('/galeria', (_, res) => res.sendFile(path.join(VIEWS_DIR, 'galeria.html')));

// — API —
app.get('/api/config', (_, res) => res.json(CONFIG));

app.post('/api/upload', ensureCloudinary, upload.array('fotos', 30), async (req, res, next) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'Nenhuma foto' });

    await Promise.all(req.files.map((file) => uploadBufferToCloudinary(file)));

    return res.json({ success: true, enviadas: req.files.length });
  } catch (err) {
    return next(err);
  }
});

app.get('/api/fotos', ensureCloudinary, async (_, res) => {
  try {
    const fotos = await listAllPhotos();
    res.json({ total: fotos.length, fotos });
  } catch {
    res.json({ total: 0, fotos: [] });
  }
});

app.get('/api/download-todas', ensureCloudinary, async (req, res, next) => {
  try {
    const fotos = await listAllPhotos();
    if (!fotos.length) return res.status(404).send('Nenhuma foto ainda');

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => next(err));

    res.attachment(`fotos-festa-${CONFIG.nome}.zip`);
    archive.pipe(res);

    await Promise.all(
      fotos.map(
        (foto, i) =>
          new Promise((resolve, reject) => {
            https
              .get(foto.url, (imgRes) => {
                if (imgRes.statusCode !== 200) {
                  imgRes.resume();
                  return reject(new Error(`Falha ao baixar imagem ${foto.arquivo}`));
                }

                const parsed = path.parse(new URL(foto.url).pathname);
                const ext = parsed.ext || '.jpg';
                archive.append(imgRes, { name: `${String(i + 1).padStart(3, '0')}-${foto.arquivo}${ext}` });
                return resolve();
              })
              .on('error', reject);
          })
      )
    );

    await archive.finalize();
    return undefined;
  } catch (err) {
    return next(err);
  }
});

// Erros do multer
app.use((err, _, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Arquivo muito grande (máx 30MB)' });
  }

  if (err) {
    return res.status(500).json({ error: err.message || 'Erro interno no servidor' });
  }

  return next();
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🎂 Festa do(a) ${CONFIG.nome}!`);
    console.log(`📸 Upload:  http://localhost:${PORT}`);
    console.log(`🖼️  Galeria: http://localhost:${PORT}/galeria\n`);
  });
}

module.exports = app;
