const express = require('express');
const router = express.Router();
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { upload, checkFileSignature } = require('../middleware/upload');
const multer = require('multer');

router.post('/', requireAuth, (req, res, next) => {
  upload.any()(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    const file = req.file || (req.files && req.files[0]);
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const isValidSignature = await checkFileSignature(file.path, file.originalname);
    if (!isValidSignature) {
      try {
        await fs.promises.unlink(file.path);
      } catch (unlinkErr) {
        console.error('Failed to delete invalid file:', unlinkErr);
      }
      return res.status(400).json({ error: 'Invalid file content. Uploaded file failed security validation.' });
    }

    const fileUrl = `/uploads/${file.filename}`;
    res.json({ url: fileUrl, imageUrl: fileUrl, audioUrl: fileUrl, fileUrl });
  });
});

module.exports = router;
