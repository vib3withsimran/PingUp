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
    'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json',
    'audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'audio/aac', 'audio/mpeg', 'audio/mp3', 'video/webm'
  ];
  const allowedExtensions = [
    '.jpg', '.jpeg', '.png', '.gif', '.webp',
    '.pdf', '.txt', '.md', '.csv', '.json',
    '.webm', '.ogg', '.wav', '.mp3', '.m4a', '.aac', '.mp4'
  ];

  const isMimeAllowed = allowedMimeTypes.includes(file.mimetype);
  const isExtensionAllowed = allowedExtensions.includes(path.extname(file.originalname).toLowerCase());

  if (isMimeAllowed && isExtensionAllowed) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only images, audio recordings, and safe documents are allowed.'), false);
  }
};

const upload = multer({ 
  storage, 
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
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

    // Ogg: OggS (0x4F, 0x67, 0x67, 0x53)
    if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
      return true;
    }

    // WebM / EBML: 1A 45 DF A3
    if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
      return true;
    }

    // WAV: RIFF at 0..3
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
      return true;
    }

    // MP3: ID3 (0x49, 0x44, 0x33) or frame sync (0xFF, 0xE0+)
    if ((buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) ||
        (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0)) {
      return true;
    }

    // MP4 / M4A: ftyp at bytes 4..7
    if (bytesRead >= 8 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
      return true;
    }

    // AAC: sync word 0xFFF or ID3
    if (buffer[0] === 0xFF && (buffer[1] & 0xF0) === 0xF0) {
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
