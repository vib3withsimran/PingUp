const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const randomSuffix = crypto.randomBytes(8).toString('hex');
    cb(null, `${Date.now()}-${randomSuffix}${path.extname(file.originalname)}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json'
  ];
  const allowedExtensions = [
    '.jpg', '.jpeg', '.png', '.gif', '.webp',
    '.pdf', '.txt', '.md', '.csv', '.json'
  ];

  const isMimeAllowed = allowedMimeTypes.includes(file.mimetype);
  const isExtensionAllowed = allowedExtensions.includes(path.extname(file.originalname).toLowerCase());

  if (isMimeAllowed && isExtensionAllowed) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only images and safe documents are allowed.'), false);
  }
};

const upload = multer({ 
  storage, 
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

async function checkFileSignature(filePath, originalName) {
  let fileHandle;
  try {
    fileHandle = await fs.promises.open(filePath, 'r');
    const extension = path.extname(originalName).toLowerCase();
    const textExtensions = ['.txt', '.md', '.csv', '.json'];

    if (textExtensions.includes(extension)) {
      const stat = await fileHandle.stat();
      const readSize = Math.min(stat.size, 4096);
      if (readSize === 0) return true;

      const buffer = Buffer.alloc(readSize);
      await fileHandle.read(buffer, 0, readSize, 0);

      if (extension === '.json') {
        const content = buffer.toString('utf8').trim();
        if (!content.startsWith('{') && !content.startsWith('[')) return false;
      }

      return !buffer.includes(0x00);
    }

    const buffer = Buffer.alloc(12);
    const { bytesRead } = await fileHandle.read(buffer, 0, 12, 0);

    if (bytesRead < 4) return false;

    // PDF: %PDF
    if (extension === '.pdf') {
      return buffer[0] === 0x25 && buffer[1] === 0x50
        && buffer[2] === 0x44 && buffer[3] === 0x46;
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return true;

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (bytesRead >= 8 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
        buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
      return true;
    }

    // GIF: GIF87a or GIF89a
    if (bytesRead >= 6 &&
        buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38 &&
        (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61) {
      return true;
    }

    // WEBP: RIFF at 0..3, and WEBP at 8..11
    if (bytesRead >= 12 &&
        buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return true;
    }

    return false;
  } catch (error) {
    console.error('Error validating image file signature:', error);
    return false;
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

module.exports = {
  upload,
  checkFileSignature,
  uploadDir
};
