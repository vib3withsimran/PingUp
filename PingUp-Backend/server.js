require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Image upload setup
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '');
    const randomSuffix = crypto.randomBytes(4).toString('hex');
    cb(null, `${Date.now()}-${randomSuffix}-${base}${ext}`);
  },
});

/**
 * Filter uploaded files based on MIME type and file extension.
 * 
 * Non-obvious decisions:
 * 1. Double validation: checks both content-type (mimetype) and file extension to mitigate
 *    malicious extension renaming bypasses (e.g. uploading .html disguised as .png).
 * 2. Whitelist approach: restricts uploads strictly to safe image assets and documents
 *    to prevent Cross-Site Scripting (XSS) via HTML uploads or Remote Code Execution (RCE) in public static directories.
 */
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
    cb(new Error('Invalid file type. Only Images and safe Documents (PDF, TXT, MD, CSV, JSON) are allowed.'), false);
  }
};

const upload = multer({ 
  storage, 
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

const { pubClient, subClient, redisClient, redisReady } = require('./config/redis');
const { messageQueue } = require('./services/messageQueue');

const User = require('./models/User');
const Room = require('./models/Room');
const { uploadDir } = require('./middleware/upload');

const authRoutes = require('./routes/auth');
const uploadRoutes = require('./routes/upload');
const usersRoutes = require('./routes/users');
const channelsRoutes = require('./routes/channels');
const dmRoutes = require('./routes/dm');
const messagesRoutes = require('./routes/messages');
const searchRoutes = require('./routes/search');
const { initializeSockets } = require('./sockets/index');

const app = express();
const server = http.createServer(app);

const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
    : [
        "http://localhost:5173",
        "https://pingupsite.onrender.com"
      ];

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    }
});
io.adapter(createAdapter(pubClient, subClient));

app.use(
    cors({
        origin: allowedOrigins,
        credentials: true
    })
);
app.use(express.json());
// Serve uploaded files securely
app.use('/uploads', (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    next();
}, express.static(uploadDir));

/**
 * Verifies that the file content starts with a valid image/document header (magic bytes)
 * or passes heuristic text validation.
 */
async function checkFileSignature(filePath, originalname) {
  const ext = path.extname(originalname).toLowerCase();

  let fileHandle;
  try {
    fileHandle = await fs.promises.open(filePath, 'r');
    
    // For text-based files, we read more to check for null bytes
    const textExtensions = ['.txt', '.md', '.csv', '.json'];
    if (textExtensions.includes(ext)) {
      const stat = await fileHandle.stat();
      const readSize = Math.min(stat.size, 4096);
      if (readSize === 0) return true; // Empty files are safe text
      
      const buffer = Buffer.alloc(readSize);
      await fileHandle.read(buffer, 0, readSize, 0);
      
      if (ext === '.json') {
          const str = buffer.toString('utf8').trim();
          if (!str.startsWith('{') && !str.startsWith('[')) return false;
      }

      for (let i = 0; i < readSize; i++) {
          if (buffer[i] === 0x00) return false;
      }
      return true;
    }

    const buffer = Buffer.alloc(12);
    const { bytesRead } = await fileHandle.read(buffer, 0, 12, 0);

    if (bytesRead < 4) {
      return false;
    }

    // PDF: %PDF (25 50 44 46)
    if (ext === '.pdf') {
       if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return true;
       return false;
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return true;
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (bytesRead >= 8 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
        buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
      return true;
    }

    // GIF: GIF87a or GIF89a
    // 47 49 46 38 37 61 or 47 49 46 38 39 61
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

// Image upload route
app.post('/api/upload', requireAuth, (req, res, next) => {
  upload.single('image')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      // Multer specific errors (e.g. file size limit exceeded)
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      // Custom fileFilter rejection error or other unknown errors
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Server-side magic-byte/content signature validation
    const isValidSignature = await checkFileSignature(req.file.path, req.file.originalname);
    if (!isValidSignature) {
      try {
        await fs.promises.unlink(req.file.path);
      } catch (unlinkErr) {
        console.error('Failed to delete invalid file:', unlinkErr);
      }
      return res.status(400).json({ error: 'Invalid file content. Uploaded file failed security validation.' });
    }

    const imageUrl = `/uploads/${req.file.filename}`;
    res.json({ imageUrl });
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api', channelsRoutes);
app.use('/api/dm', dmRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/search', searchRoutes);

initializeSockets(io);

// ─── Role Helpers ──────────────────────────────────────────────────
function rollRole() {
    return Math.random() < 0.30 ? ROLES.MODERATOR : ROLES.MEMBER;
}

function safeSocketHandler(socket, eventName, handler, clientMessage = 'Something went wrong.') {
    return async (...args) => {
        try {
            await handler(...args);
        } catch (err) {
            console.error(`[socket:${eventName}]`, err);
            socket.emit('error:general', clientMessage);
        }
    };
}
// ─── Broadcast helpers ────────────────────────────────────────────
async function broadcastUserList() {
    const onlineUserIds = await redisClient.sMembers('users:online');
    if (onlineUserIds.length === 0) {
        io.emit('users:update', []);
        return;
    }
    const users = await User.find({ _id: { $in: onlineUserIds } });
    io.emit('users:update', users.map(u => u.toSafeObject()));
}
// Evict sockets from a channel room if the channel just became private
// and they are no longer authorized.
async function evictUnauthorizedSockets(room) {
    if (!room.isPrivate) return; // only act when it IS now private

    const roomIdStr = room._id.toString();

    // ✅ Fetch from BOTH join paths — some sockets join by _id, others by name
    const [socketsByIdArr, socketsByNameArr] = await Promise.all([
        io.in(roomIdStr).fetchSockets(),
        io.in(room.name).fetchSockets(),
    ]);

    // Deduplicate — a socket may appear in both sets
    const seen = new Set();
    const allSockets = [];
    for (const s of [...socketsByIdArr, ...socketsByNameArr]) {
        if (!seen.has(s.id)) {
            seen.add(s.id);
            allSockets.push(s);
        }
    }

    const allowedSet = new Set(room.allowedUsers.map(id => id.toString()));

    for (const s of allSockets) {
        const user = s.data?.user ?? s.user;
        const isOwnerOrAdmin =
            user?.role === ROLES.OWNER || user?.role === ROLES.ADMIN;
        if (isOwnerOrAdmin) continue; // owners/admins always keep access

        const isAllowed = allowedSet.has(user?.id?.toString());
        if (!isAllowed) {
            // ✅ Leave BOTH room identifiers so no messages leak through
            s.leave(roomIdStr);
            s.leave(room.name);
            s.emit('channel:kicked', {
                channelId: roomIdStr,
                reason: 'This channel has been made private.',
            });
        }
    }
}

async function broadcastStructure() {
    const rooms = await Room.find().sort({ category: 1, order: 1, createdAt: 1 });
    const categoryMap = new Map();
    for (const r of rooms) {
        const catKey = r.category || 'general';
        if (!categoryMap.has(catKey))
            categoryMap.set(catKey, { id: `cat-${catKey}`, name: catKey, channels: [] });
        categoryMap.get(catKey).channels.push(roomToChannel(r));
    }
    io.emit('structure:update', [...categoryMap.values()]);
}

// ─── Server Settings helpers ──────────────────────────────────────
async function getServerSetting(key, defaultValue) {
    try {
        const setting = await ServerSettings.findOne({ key });
        return setting ? setting.value === true : defaultValue;
    } catch {
        return defaultValue;
    }
}

async function broadcastSettings() {
    const allowUserChannelCreation = await getServerSetting('allowUserChannelCreation', false);
    io.emit('settings:update', { allowUserChannelCreation });
}

function roomToChannel(r) {
    return {
        id: r._id.toString(),
        name: r.name,
        description: r.description,
        emoji: r.emoji || '💬',
        category: r.category,
        isPrivate: r.isPrivate || false,
        isReadOnly: r.isReadOnly || false,
        isLocked: r.isLocked || false,
        isVoice: r.isVoice || false,
        allowedUsers: r.allowedUsers?.map(id => id.toString()) || [],
        pinnedMessages: r.pinnedMessages?.map(id => id.toString()) || [],
    };
}

// ─── Auth helper ──────────────────────────────────────────────────
function authHeader(req, res) {
    const authHeaderVal = req.headers.authorization;
    if (!authHeaderVal || !authHeaderVal.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Unauthorized' });
        return null;
    }
    const token = authHeaderVal.slice('Bearer '.length).trim();
    if (!token) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    const decoded = verifyToken(token);
    if (!decoded) { res.status(401).json({ error: 'Invalid token' }); return null; }
    return decoded;
}

// ─── Seed Default Rooms ───────────────────────────────────────────
async function seedRooms() {
    const defaults = [
        { name: 'general', description: 'General discussion', category: '✦ welcome', emoji: '🌿', order: 0 },
        { name: 'announcements', description: 'Official announcements', category: '✦ welcome', emoji: '📢', order: 1, isReadOnly: true },
        { name: 'rules', description: 'Server rules', category: '✦ welcome', emoji: '📋', order: 2, isReadOnly: true },
        { name: 'engineering', description: 'Engineering discussion', category: '✦ chat', emoji: '⚙️', order: 0 },
        { name: 'random', description: 'Random chat', category: '✦ chat', emoji: '🎲', order: 1 },
        { name: 'ideas', description: 'Share ideas', category: '✦ chat', emoji: '💡', order: 2 },
        { name: 'music-lounge', description: 'Stranger Things music', category: '✦ chat', emoji: '🎵', order: 3, isVoice: true },
        { name: 'admin-only', description: 'Owner & mods only', category: '✦ staff', emoji: '🔒', order: 0, isPrivate: true },
    ];
    for (const r of defaults) {
        await Room.findOneAndUpdate({ name: r.name }, r, { upsert: true, new: true });
    }
    console.log('✅ Default rooms seeded');
}

// ─── Connect & Start ──────────────────────────────────────────────
if (require.main === module) {
    mongoose.connect(process.env.MONGO_URI)
        .then(async () => {
            console.log('✅ MongoDB connected');
            await redisReady;
            await seedRooms();
            server.listen(process.env.PORT || 3001, () =>
                console.log(`🚀 Server on http://localhost:${process.env.PORT || 3001}`)
            );
        })
        .catch(err => { console.error('MongoDB error:', err); process.exit(1); });
}

module.exports = { app, server };
