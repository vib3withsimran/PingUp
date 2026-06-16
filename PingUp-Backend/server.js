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

// Image upload setup
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});

/**
 * Filter uploaded files based on MIME type and file extension.
 * 
 * Non-obvious decisions:
 * 1. Double validation: checks both content-type (mimetype) and file extension to mitigate
 *    malicious extension renaming bypasses (e.g. uploading .html disguised as .png).
 * 2. Whitelist approach: restricts uploads strictly to safe image assets (JPEG, PNG, GIF, WEBP)
 *    to prevent Cross-Site Scripting (XSS) via HTML uploads or Remote Code Execution (RCE) in public static directories.
 */
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

  const isMimeAllowed = allowedMimeTypes.includes(file.mimetype);
  const isExtensionAllowed = allowedExtensions.includes(path.extname(file.originalname).toLowerCase());

  if (isMimeAllowed && isExtensionAllowed) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WEBP images are allowed.'), false);
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
const Message = require('./models/Message');
const DirectMessage = require('./models/DirectMessage');
const { generateToken, socketAuthMiddleware, verifyToken, generateRefreshToken, verifyRefreshToken, requireAuth } = require('./middleware/auth');
const { ROLES, hasPermission } = require('./data/store'); // <-- IMPORTED WEIGHT SYSTEM

const ServerSettings = require('./models/ServerSettings');
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
// Serve uploaded images
app.use('/uploads', express.static(uploadDir));

/**
 * Verifies that the file content starts with a valid image header (magic bytes).
 * Supports JPEG, PNG, GIF, and WEBP.
 */
async function checkFileSignature(filePath) {
  let fileHandle;
  try {
    fileHandle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await fileHandle.read(buffer, 0, 12, 0);

    if (bytesRead < 4) {
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
    const isValidSignature = await checkFileSignature(req.file.path);
    if (!isValidSignature) {
      try {
        await fs.promises.unlink(req.file.path);
      } catch (unlinkErr) {
        console.error('Failed to delete invalid file:', unlinkErr);
      }
      return res.status(400).json({ error: 'Invalid file content. Uploaded file is not a valid image.' });
    }

    const imageUrl = `/uploads/${req.file.filename}`;
    res.json({ imageUrl });
  });
});


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

// ══════════════════════════════════════════════════════════════════
//  REST ROUTES
// ══════════════════════════════════════════════════════════════════

// ─── Register ─────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, email, displayName } = req.body;
        if (!username?.trim() || !password)
            return res.status(400).json({ error: 'Username and password required.' });

        const exists = await User.findOne({ username: username.trim().toLowerCase() });
        if (exists) return res.status(409).json({ error: 'Username already taken.' });

        const userCount = await User.countDocuments();
        const isFirst = userCount === 0;
        const role = isFirst ? ROLES.ADMIN : ROLES.MEMBER;

        const user = await User.create({
            username: username.trim().toLowerCase(),
            password,
            role,
            isFirst,
            displayName: displayName?.trim() || username.trim(),
            email: email?.trim() || '',
        });

        const accessToken = generateToken(user);
        const refreshToken = generateRefreshToken(user);

        user.refreshToken = refreshToken;

        await user.save();

        res.status(201).json({
            accessToken,
            refreshToken,
            user: user.toPrivateProfile(),
            roleMessage: isFirst
                  ? '👑 You are the ADMIN — full system control granted.'
                  : '👋 Welcome! You joined as a member.',
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// ─── Login ────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username: username?.trim().toLowerCase() });
        if (!user || !(await user.comparePassword(password)))
            return res.status(401).json({ error: 'Invalid credentials.' });
        if (user.banned)
            return res.status(403).json({ error: 'You have been banned.' });

        user.loginCount += 1;

        const accessToken = generateToken(user);
        const refreshToken = generateRefreshToken(user);
        user.refreshToken = refreshToken;

        await user.save();

        res.json({
            accessToken,
            refreshToken,
            user: user.toPrivateProfile()
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

// ─── Refresh Route ────────────────────────────────────────────────
app.post('/api/refresh', async (req, res) => {
    const refreshToken =
        req.body && typeof req.body === 'object' ? req.body.refreshToken : undefined;

    // Strict validation: refreshToken must exist and be a primitive string.
    // This blocks NoSQL Query Object injection (e.g. passing { $ne: null }).
    if (!refreshToken || typeof refreshToken !== 'string') {
        return res.status(400).json({
            error: 'Invalid refresh token format.'
        });
    }

    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded) {
        return res.status(403).json({
            error: 'Invalid or expired refresh token'
        });
    }

    try {
        const user = await User.findById(decoded.id);

        if (!user || user.refreshToken !== refreshToken) {
            return res.status(403).json({
                error: 'Invalid refresh token'
            });
        }

        const accessToken = generateToken(user);
        res.json({ accessToken });

    } catch (err) {
        res.status(500).json({
            error: 'Server error.'
        });
    }
});

// ─── Logout ────────────────────────────────────────────────
app.post('/api/logout', async (req, res) => {
    try {
        const refreshToken =
            req.body && typeof req.body === 'object' ? req.body.refreshToken : undefined;
        
        // Strict validation: refreshToken must exist and be a primitive string.
        // Bypassing this with a query object ({ $ne: null }) could match unintended users.
        if (!refreshToken || typeof refreshToken !== 'string') {
            return res.status(400).json({
                error: 'Invalid refresh token format.'
            });
        }

        const user = await User.findOne({ refreshToken });

        if (user) {
            user.refreshToken = null;
            await user.save();
        }

        res.json({
            message: 'Logged out successfully'
        });

    } catch (err) {
        res.status(500).json({
            error: 'Server error.'
        });
    }
});

// ─── Get structure ────────────────────────────────────────────────
app.get('/api/structure', async (req, res) => {
const decoded = authHeader(req, res);
if (!decoded) return;

const me = await User.findById(decoded.id);

const rooms = await Room.find().sort({ category: 1, order: 1, createdAt: 1 });
const categoryMap = new Map();

for (const r of rooms) {
  if (r.isPrivate) {
    const isModOrOwner = hasPermission(me.role, ROLES.MODERATOR);

    const isAllowedUser = r.allowedUsers.some(
      id => id.toString() === me._id.toString()
    );

    if (!isModOrOwner && !isAllowedUser) {
      continue;
    }
  }

  const catKey = r.category || 'general';

  if (!categoryMap.has(catKey)) {
    categoryMap.set(catKey, {
      id: `cat-${catKey}`,
      name: catKey,
      channels: []
    });
  }

  categoryMap.get(catKey).channels.push(roomToChannel(r));
}

res.json([...categoryMap.values()]);
});

// ─── Get Rooms (legacy) ───────────────────────────────────────────
app.get('/api/rooms', async (req, res) => {
const decoded = authHeader(req, res);
if (!decoded) return;

const me = await User.findById(decoded.id);

const rooms = await Room.find().sort({ createdAt: 1 });

const filteredRooms = rooms.filter(room => {
  if (!room.isPrivate) return true;

  if (hasPermission(me.role, ROLES.MODERATOR)) {
    return true;
  }

  return room.allowedUsers?.some(
    userId => userId.toString() === me._id.toString()
  );
});

res.json(filteredRooms.map(r => roomToChannel(r)));
});

// ─── Get Users ────────────────────────────────────────────────────
app.get('/api/users', async (req, res) => {
    const decoded = authHeader(req, res);
    if (!decoded) return;
    const me = await User.findById(decoded.id);

    // Use Weight system to check if user is at least a Moderator!
    if (!hasPermission(me.role, ROLES.MODERATOR))
        return res.status(403).json({ error: 'Forbidden' });

    const users = await User.find();
    res.json(users.map(u => ({
        id: u._id.toString(),
        username: u.username,
        role: u.role,
        displayName: u.displayName,
        online: u.online,
        banned: u.banned || false,
        createdAt: u.createdAt,
        loginCount: u.loginCount,
    })));
});

// ─── Update Profile ───────────────────────────────────────────────
app.put('/api/profile', async (req, res) => {
    try {
        const decoded = authHeader(req, res);
        if (!decoded) return;
        const updates = {
            ...(req.body.username !== undefined ? { username: req.body.username.trim().toLowerCase() } : {}),
            ...(req.body.displayName !== undefined ? { displayName: req.body.displayName.trim() } : {}),
            ...(req.body.email !== undefined ? { email: req.body.email.trim() } : {}),
            ...(req.body.phone !== undefined ? { phone: req.body.phone.trim() } : {}),
        };
        const user = await User.findByIdAndUpdate(decoded.id, updates, {
          new: true,
          runValidators: true
        });
        if (!user) return res.status(404).json({ error: 'User not found.' });
        res.json({ user: user.toPrivateProfile() });
    }catch (err) {
        if (err?.code === 11000 && err?.keyPattern?.username) {
           return res.status(409).json({ error: 'Username already taken.' });
        }
        console.error(err);
        return res.status(500).json({ error: 'Server error.' });
    }
});

// ─── DM: history ─────────────────────────────────────────────────
app.get('/api/dm/:otherUserId', async (req, res) => {
    try {
        const decoded = authHeader(req, res);
        if (!decoded) return;
        const convId = [decoded.id, req.params.otherUserId].sort().join('_');
        const msgs = await DirectMessage
            .find({ conversationId: convId, deleted: false })
            .sort({ createdAt: -1 }).limit(50).lean();
        await DirectMessage.updateMany(
            { conversationId: convId, senderId: { $ne: decoded.id }, read: false },
            { read: true }
        );
        res.json(msgs.reverse().map(m => ({
            id: m._id.toString(),
            conversationId: m.conversationId,
            senderId: m.senderId.toString(),
            senderUsername: m.senderUsername,
            senderRole: m.senderRole,
            text: m.text,
            timestamp: m.createdAt,
            read: m.read,
        })));
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── DM: conversations list ───────────────────────────────────────
app.get('/api/dm', async (req, res) => {
    try {
        const decoded = authHeader(req, res);
        if (!decoded) return;
        const myId = new mongoose.Types.ObjectId(decoded.id);
        const convos = await DirectMessage.aggregate([
            { $match: { participants: myId, deleted: false } },
            { $sort: { createdAt: -1 } },
            { $group: { _id: '$conversationId', lastMessage: { $first: '$$ROOT' } } },
            { $sort: { 'lastMessage.createdAt': -1 } },
        ]);
        const result = await Promise.all(convos.map(async (c) => {
            const otherId = c._id.split('_').find(id => id !== decoded.id);
            const other = await User.findById(otherId).lean();
            const unread = await DirectMessage.countDocuments({
                conversationId: c._id, senderId: { $ne: myId }, read: false,
            });
            return {
                conversationId: c._id,
                otherUser: other
                    ? { id: other._id.toString(), username: other.username, role: other.role, online: other.online }
                    : null,
                lastMessage: c.lastMessage.text,
                lastMessageTime: c.lastMessage.createdAt,
                unreadCount: unread,
            };
        }));
        res.json(result.filter(r => r.otherUser));
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ══════════════════════════════════════════════════════════════════
//  COMMAND PROCESSOR
// ══════════════════════════════════════════════════════════════════
async function processCommand(socket, roomName, text) {
    const [cmd, ...args] = text.slice(1).split(' ');

    // Use the new Weight-based checker!
    const isOwner = hasPermission(socket.user.role, ROLES.ADMIN);
    const isMod = hasPermission(socket.user.role, ROLES.MODERATOR);
    console.log(`[DEBUG] User Role: ${socket.user.role} | isOwner: ${isOwner}`);
    const ok = msg => socket.emit('command:response', { type: 'success', text: `✅ ${msg}` });
    const err = msg => socket.emit('command:response', { type: 'error', text: `❌ ${msg}` });
    const info = msg => socket.emit('command:response', { type: 'help', text: msg });
    const perm = msg => socket.emit('error:permission', msg);

    switch (cmd.toLowerCase()) {

        case 'help':
            info([
                '── General ──',
                '/help                            show this list',
                '/online                          list online users',
                '/whoami                          your info',
                '/rooms                           list all channels',
                '',
                '── Moderation (mod+) ──',
                '/delete <msgId>                  delete a message',
                '/pin <msgId>                     pin a message',
                '/kick <user>                     kick a user',
                '',
                '── Admin Only (admin) ──',
                '/newchannel <cat> <name> [emoji]  create channel',
                '/delchannel <name>               delete channel',
                '/renamechannel <old> <new>       rename channel',
                '/newcategory <name>              create category',
                '/readonly <channel>              toggle read-only',
                '/lock <channel>                  toggle locked',
                '/private <channel>              toggle private',
                '/adduser <channel> <user>        allow user to private room',
                '/removeuser <channel> <user>     remove user from private room',
                '/promote <user> <role>           set role (member/moderator)',
                '/ban <user>                      ban user',
                '/reroll <user>                   re-roll role randomly',
                '/clear                           wipe room messages',
                '/stats                           server stats',
            ].join('\n'));
            break;

        case 'online': {
            const users = await User.find({ online: true });
            info(users.map(u => `${u.username} [${u.role}]`).join('\n') || 'No users online');
            break;
        }

        case 'whoami': {
            const user = await User.findById(socket.user.id);
            info(`Username: ${user.username}\nRole: ${user.role}\nLogins: ${user.loginCount}\nJoined: ${user.createdAt.toDateString()}`);
            break;
        }

        case 'rooms': {
            const rooms = await Room.find().sort({ category: 1, name: 1 });
            info(rooms.map(r =>
                `${r.emoji} #${r.name} [${r.category}]${r.isReadOnly ? ' 🔇' : ''}${r.isLocked ? ' 🔒' : ''}${r.isPrivate ? ' 👁️' : ''}${r.isVoice ? ' 🎵' : ''}`
            ).join('\n'));
            break;
        }

        case 'stats': {
            if (!isOwner) return perm('Only the admin can view stats.');
            const [uc, mc, rc, oc] = await Promise.all([
                User.countDocuments(),
                Message.countDocuments({ deleted: false }),
                Room.countDocuments(),
                User.countDocuments({ online: true }),
            ]);
            info(`📊 Server Stats\nUsers: ${uc} (${oc} online)\nChannels: ${rc}\nMessages: ${mc}`);
            break;
        }

        case 'delete': {
            if (!isMod) return perm('Moderators only.');
            const msg = await Message.findByIdAndUpdate(
                args[0], { deleted: true, text: '[message deleted]' }, { new: true }
            );
            if (!msg) return err('Message not found.');
            io.to(roomName).emit('message:deleted', { id: args[0] });
            ok('Message deleted.');
            break;
        }

        case 'pin': {
            if (!isMod) return perm('Moderators only.');
            const msg = await Message.findById(args[0]);
            if (!msg) return err('Message not found.');
            const room = await Room.findOne({ name: roomName });
            if (!room) return err('Room not found.');
            const already = room.pinnedMessages.some(id => id.toString() === args[0]);
            if (already) {
                room.pinnedMessages = room.pinnedMessages.filter(id => id.toString() !== args[0]);
                await room.save();
                io.to(roomName).emit('message:unpinned', { id: args[0] });
                ok('Message unpinned.');
            } else {
                room.pinnedMessages.push(args[0]);
                await room.save();
                io.to(roomName).emit('message:pinned', {
                    id: args[0], text: msg.text, pinnedBy: socket.user.username,
                });
                ok('Message pinned.');
            }
            break;
        }

        case 'kick': {
            if (!isMod) return perm('Moderators only.');
            const target = await User.findOne({ username: args[0], online: true });
            if (!target) return err('User not found or offline.');
            if (target.role === ROLES.ADMIN) return err('Cannot kick the admin.');
            if (socket.user.role === ROLES.MODERATOR && target.role !== ROLES.MEMBER)
                return err('Moderators can only kick members.');
            const ts = [...io.sockets.sockets.values()].find(s => s.user?.id === target._id.toString());
            if (ts) { ts.emit('kicked', { by: socket.user.username }); ts.disconnect(true); }
            ok(`${args[0]} kicked.`);
            io.emit('room:notification', { text: `👢 ${args[0]} was kicked`, type: 'system' });
            break;
        }

        case 'newchannel': {
            if (!isOwner) return perm('Admin only.');
            const [catName, chName, emoji] = args;
            if (!catName || !chName) return err('Usage: /newchannel <category> <name> [emoji]');
            const exists = await Room.findOne({ name: chName.toLowerCase() });
            if (exists) return err(`#${chName} already exists.`);
            const room = await Room.create({
                name: chName.toLowerCase().replace(/\s+/g, '-'),
                description: `Created by ${socket.user.username}`,
                emoji: emoji || '💬',
                category: catName,
                createdBy: socket.user.username,
            });
            await broadcastStructure();
            ok(`Channel #${room.name} created in [${catName}].`);
            io.emit('room:notification', { text: `# ${room.name} created`, type: 'system' });
            break;
        }

        case 'delchannel': {
            if (!isOwner) return perm('Admin only.');
            const room = await Room.findOneAndDelete({ name: args[0]?.toLowerCase() });
            if (!room) return err(`#${args[0]} not found.`);
            await Message.deleteMany({ roomName: args[0] });
            await broadcastStructure();
            ok(`#${args[0]} deleted.`);
            break;
        }

        case 'renamechannel': {
            if (!isOwner) return perm('Admin only.');
            const [oldName, newName] = args;
            if (!oldName || !newName) return err('Usage: /renamechannel <old> <new>');
            const formattedNewName = newName.toLowerCase().replace(/\s+/g, '-');
            const room = await Room.findOneAndUpdate(
                { name: oldName.toLowerCase() },
                { name: formattedNewName },
                { new: true }
            );
            if (!room) return err(`#${oldName} not found.`);
            await Message.updateMany({ roomName: oldName.toLowerCase() }, { roomName: formattedNewName });
            await broadcastStructure();
            ok(`#${oldName} → #${newName}.`);
            break;
        }

        case 'newcategory': {
            if (!isOwner) return perm('Admin only.');
            const catName = args.join(' ');
            if (!catName) return err('Usage: /newcategory <name>');
            await Room.create({
                name: `${catName.toLowerCase().replace(/\s+/g, '-')}-general`,
                description: `Default channel`,
                emoji: '💬',
                category: catName,
                createdBy: socket.user.username,
            });
            await broadcastStructure();
            ok(`Category "${catName}" created.`);
            break;
        }

        case 'readonly': {
            if (!isOwner) return perm('Admin only.');
            const room = await Room.findOne({ name: args[0]?.toLowerCase() });
            if (!room) return err(`#${args[0]} not found.`);
            room.isReadOnly = !room.isReadOnly;
            await room.save();
            await broadcastStructure();
            io.to(room.name).emit('room:settings', roomToChannel(room));
            ok(`#${room.name} is now ${room.isReadOnly ? 'read-only 🔇' : 'writable ✍️'}.`);
            break;
        }

        case 'lock': {
            if (!isOwner) return perm('Admin only.');
            const room = await Room.findOne({ name: args[0]?.toLowerCase() });
            if (!room) return err(`#${args[0]} not found.`);
            room.isLocked = !room.isLocked;
            await room.save();
            await broadcastStructure();
            io.to(room.name).emit('room:settings', roomToChannel(room));
            ok(`#${room.name} is now ${room.isLocked ? 'locked 🔒' : 'unlocked 🔓'}.`);
            break;
        }

        case 'private': {
            if (!isOwner) return perm('Admin only.');
            const room = await Room.findOne({ name: args[0]?.toLowerCase() });
            if (!room) return err(`#${args[0]} not found.`);
            room.isPrivate = !room.isPrivate;
            await room.save();
            await broadcastStructure();
            ok(`#${room.name} is now ${room.isPrivate ? 'private 👁️' : 'public 🌐'}.`);
            break;
        }

        case 'adduser': {
            if (!isOwner) return perm('Admin only.');
            const [chName, uname] = args;
            const room = await Room.findOne({ name: chName?.toLowerCase() });
            const target = await User.findOne({ username: uname });
            if (!room) return err(`#${chName} not found.`);
            if (!target) return err(`User "${uname}" not found.`);
            if (!room.allowedUsers.includes(target._id)) {
                room.allowedUsers.push(target._id);
                await room.save();
            }
            await broadcastStructure();
            ok(`${uname} added to #${chName}.`);
            break;
        }

        case 'removeuser': {
            if (!isOwner) return perm('Admin only.');
            const [chName, uname] = args;
            const room = await Room.findOne({ name: chName?.toLowerCase() });
            const target = await User.findOne({ username: uname });
            if (!room) return err(`#${chName} not found.`);
            if (!target) return err(`User "${uname}" not found.`);
            room.allowedUsers = room.allowedUsers.filter(id => id.toString() !== target._id.toString());
            await room.save();
            await broadcastStructure();
            ok(`${uname} removed from #${chName}.`);
            break;
        }

        case 'promote': {
            if (!isOwner) return perm('Admin only.');
            const [targetName, newRole] = args;
            if (![ROLES.MODERATOR, ROLES.MEMBER].includes(newRole))
                return err('Role must be: moderator or member');
            // Lookup first so we can guard the target role before any write
            // (prevents owners from demoting themselves or other owners —
            //  matches the existing /kick, /reroll, /ban pattern).
            const targetUser = await User.findOne({ username: targetName });
            if (!targetUser) return err('User not found.');
            if (targetUser.role === ROLES.ADMIN)
                return err('Cannot change the admin role.');
            await User.updateOne({ _id: targetUser._id }, { role: newRole });
            const ls = [...io.sockets.sockets.values()].find(s => s.user?.id === targetUser._id.toString());
            if (ls) { ls.user.role = newRole; ls.emit('role:updated', { role: newRole }); }
            await broadcastUserList();
            ok(`${targetName} is now ${newRole}.`);
            io.emit('room:notification', { text: `🔰 ${targetName} → ${newRole}`, type: 'system' });
            break;
        }

        case 'ban': {
            if (!isOwner) return perm('Admin only.');
            const target = await User.findOne({ username: args[0] });
            if (!target) return err('User not found.');
            if (target.role === ROLES.ADMIN) return err('Cannot ban the admin.');
            target.banned = true;
            await target.save();
            const ts = [...io.sockets.sockets.values()].find(s => s.user?.id === target._id.toString());
            if (ts) { ts.emit('kicked', { by: `${socket.user.username} (banned)` }); ts.disconnect(true); }
            ok(`${args[0]} banned.`);
            io.emit('room:notification', { text: `🔨 ${args[0]} was banned`, type: 'system' });
            break;
        }

        case 'reroll': {
            if (!isOwner) return perm('Admin only.');
            const target = await User.findOne({ username: args[0] });
            if (!target) return err('User not found.');
            if (target.role === ROLES.ADMIN) return err('Cannot reroll the admin.');
            const newRole = rollRole();
            target.role = newRole;
            await target.save();
            const ls = [...io.sockets.sockets.values()].find(s => s.user?.id === target._id.toString());
            if (ls) { ls.user.role = newRole; ls.emit('role:updated', { role: newRole }); }
            await broadcastUserList();
            ok(`🎲 ${args[0]} rerolled → ${newRole.toUpperCase()}`);
            io.emit('room:notification', { text: `🎲 ${args[0]}'s role rerolled to ${newRole}`, type: 'system' });
            break;
        }

        case 'clear': {
            if (!isOwner) return perm('Admin only.');
            await Message.updateMany({ roomName }, { deleted: true, text: '[message deleted]' });
            io.to(roomName).emit('room:cleared');
            ok(`#${roomName} cleared.`);
            break;
        }

        default:
            err(`Unknown command: /${cmd}. Type /help`);
    }
}

// ══════════════════════════════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════════════════════════════
io.use(socketAuthMiddleware);

io.on('connection', async (socket) => {
    let dbUser = null;
    try{
        dbUser = await User.findById(socket.user.id);
        if (!dbUser) return socket.disconnect();
        if (dbUser.banned) {
            socket.emit('kicked', { by: 'server (banned)' });
            return socket.disconnect();
        }
    

    // Sync role from DB
    socket.user.role = dbUser.role;

    await redisClient.sAdd(`user:sockets:${socket.user.id}`, socket.id);
    await redisClient.sAdd('users:online', socket.user.id);
    await User.findByIdAndUpdate(socket.user.id, { online: true, socketId: socket.id });
    await broadcastUserList();

    // Send filtered structure on connect
    const rooms = await Room.find().sort({ category: 1, order: 1, createdAt: 1 });
    const categoryMap = new Map();
    for (const r of rooms) {

    if (r.isPrivate) {

        const isModOrOwner = hasPermission(
            socket.user.role,
            ROLES.MODERATOR
        );

        const isAllowedUser = r.allowedUsers.some(
            id => id.toString() === socket.user.id
        );

        if (!isModOrOwner && !isAllowedUser) {
            continue;
        }
    }

    const catKey = r.category || 'general';

    if (!categoryMap.has(catKey)) {
        categoryMap.set(catKey, {
            id: `cat-${catKey}`,
            name: catKey,
            channels: []
        });
    }

    categoryMap.get(catKey).channels.push(roomToChannel(r));
}
    socket.emit('structure:update', [...categoryMap.values()]);
    const allowUserChannelCreation = await getServerSetting('allowUserChannelCreation', false);
    socket.emit('settings:update', { allowUserChannelCreation });
    console.log(`[+] ${socket.user.username} (${socket.user.role})`);
}catch(err){
    console.error('[connection] setup error:', err);
    socket.emit('error:general', 'Connection setup failed.');
    socket.disconnect();
    return;
}

    // ── Join channel (by name) ─────────────────────────────────────
    socket.on('room:join', safeSocketHandler(socket, 'room:join', async ({ roomName }) => {
        const room = await Room.findOne({ name: roomName });
        if (!room) return socket.emit('error:general', 'Channel not found.');
        if (room.isPrivate && socket.user.role === ROLES.MEMBER) {
            const allowed = room.allowedUsers.map(id => id.toString()).includes(socket.user.id);
            if (!allowed) return socket.emit('error:permission', 'This channel is private.');
        }
        ;[...socket.rooms].forEach(r => { if (r !== socket.id) socket.leave(r); });
        socket.join(roomName);
        socket.currentRoom = roomName;
        const history = await Message.find({ roomName, deleted: false })
            .sort({ createdAt: -1 }).limit(50).lean();
        const pinnedIds = room.pinnedMessages.map(id => id.toString());
        socket.emit('room:history', {
            roomName,
            messages: history.reverse().map(m => ({
                id: m._id.toString(),
                userId: m.userId.toString(),
                username: m.username,
                role: m.role,
                text: m.text,
                timestamp: m.createdAt,
                deleted: m.deleted,
                pinned: pinnedIds.includes(m._id.toString()),
                editedAt: m.editedAt,
                editHistory: m.editHistory,

                // THREAD FIX
                parentMessageId: m.parentMessageId,
                replyCount: m.replyCount || 0,
            })),
        });
        io.to(roomName).emit('room:notification', {
            text: `${socket.user.username} joined #${roomName}`, type: 'join',
        });
    }, 'Failed to join channel.'));

    // ── Join channel (by ID) ───────────────────────────────────────
    socket.on('channel:join', safeSocketHandler(socket, 'channel:join', async ({ channelId }) => {
        const room = await Room.findById(channelId);
        if (!room) return socket.emit('error:general', 'Channel not found.');
        if (room.isPrivate && socket.user.role === ROLES.MEMBER) {
            const allowed = room.allowedUsers.map(id => id.toString()).includes(socket.user.id);
            if (!allowed) return socket.emit('error:permission', 'This channel is private.');
        }
        ;[...socket.rooms].forEach(r => { if (r !== socket.id) socket.leave(r); });
        socket.join(channelId);
        socket.currentRoom = room.name;
        socket.currentChannelId = channelId;
        const history = await Message.find({ roomName: room.name, deleted: false })
            .sort({ createdAt: -1 }).limit(50).lean();
        const pinnedIds = room.pinnedMessages.map(id => id.toString());
        socket.emit('channel:history', {
            channelId,
            messages: history.reverse().map(m => ({
                id: m._id.toString(),
                userId: m.userId.toString(),
                username: m.username,
                role: m.role,
                text: m.text,
                timestamp: m.createdAt,
                deleted: m.deleted,
                pinned: pinnedIds.includes(m._id.toString()),
                editedAt: m.editedAt,
                editHistory: m.editHistory,

                // THREAD FIX
                parentMessageId: m.parentMessageId,
                replyCount: m.replyCount || 0,
            })),
            roomSettings: roomToChannel(room),
        });
    }, 'Failed to join channel.'));

    // ── Send message ───────────────────────────────────────────────
    socket.on(
        'message:send',
        safeSocketHandler(
            socket,
            'message:send',
            async ({ roomName, channelId, text, parentMessageId, imageUrl }) => {
                const trimmed = text?.trim();
               if (!trimmed && !imageUrl) return;

               if (trimmed && trimmed.length > MAX_MESSAGE_LENGTH) {
                   return socket.emit(
                       'error:general',
                       `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters.`
                   );
               }

                let resolvedRoom = roomName;
                let room = null;
                if (channelId) {
                    room = await Room.findById(channelId);
                    resolvedRoom = room?.name;
                } else {
                    room = await Room.findOne({ name: roomName });
                }
                if (!resolvedRoom || !room) return;

                if (trimmed.startsWith('/')) return processCommand(socket, resolvedRoom, trimmed);

                const freshUser = await User.findById(socket.user.id);

                // Check using new weight permissions
                if (room.isReadOnly && !hasPermission(freshUser.role, ROLES.ADMIN))
                    return socket.emit('error:permission', `#${room.name} is read-only.`);
                if (room.isLocked)
                    return socket.emit('error:permission', `#${room.name} is locked.`);

                // All base users are at least Members, so they can send.
                if (!hasPermission(freshUser.role, ROLES.MEMBER))
                    return socket.emit('error:permission', 'You cannot send messages.');

                const msgId = new mongoose.Types.ObjectId();

                await messageQueue.add('send-message', {
                    _id: msgId,
                    roomName: resolvedRoom,
                    userId: socket.user.id,
                    username: socket.user.username,
                    role: freshUser.role,
                    text: trimmed,
                    parentMessageId: parentMessageId || null, 
                    imageUrl: imageUrl || null,
                });

                const payload = {
                    id: msgId.toString(), userId: socket.user.id,
                    username: socket.user.username, role: freshUser.role,
                    text: trimmed, timestamp: new Date(), deleted: false, pinned: false,
                    parentMessageId: parentMessageId || null,
                    replyCount: 0,
                };

                io.to(resolvedRoom).emit('message:new', payload);
                if (channelId && channelId !== resolvedRoom) {
                    io.to(channelId).emit('message:new', payload);
                }
            }, 'Message failed to send.'));

    // ── Typing ─────────────────────────────────────────────────────
    socket.on('typing:start', ({ roomName, channelId }) => {
        socket.to(channelId || roomName).emit('typing:update', {
            username: socket.user.username, typing: true,
        });
    });
    socket.on('typing:stop', ({ roomName, channelId }) => {
        socket.to(channelId || roomName).emit('typing:update', {
            username: socket.user.username, typing: false,
        });
    });

    // ── Owner: channel CRUD ────────────────────────────────────────
    socket.on('channel:create', safeSocketHandler(socket, 'channel:create', async ({ categoryId, name, description, emoji }) => {
        const allowUserChannelCreation = await getServerSetting('allowUserChannelCreation', false);
        const isOwner = socket.user.role === 'owner';
        const isMod = ['owner', 'moderator'].includes(socket.user.role);

        if (!isOwner && !allowUserChannelCreation)
            return socket.emit('error:permission', 'Channel creation is restricted to admins.');
        if (!isOwner && !isMod && !allowUserChannelCreation)
            return socket.emit('error:permission', 'You do not have permission to create channels.');
        if (!name?.trim()) return;
        const exists = await Room.findOne({ name: name.trim().toLowerCase() });
        if (exists) return socket.emit('error:general', 'Channel name already exists.');
        const room = await Room.create({
            name: name.trim().toLowerCase().replace(/\s+/g, '-'),
            description: description?.trim() || '',
            emoji: emoji || '💬',
            category: categoryId,
            createdBy: socket.user.username,
        });
        await broadcastStructure();
        io.emit('room:notification', { text: `# ${room.name} created`, type: 'system' });
    }, 'Failed to create channel.'));

    socket.on('channel:delete', safeSocketHandler(socket, 'channel:delete', async ({ channelId }) => {
        if (socket.user.role !== 'owner')
            return socket.emit('error:permission', 'Owner only.');
        const room = await Room.findByIdAndDelete(channelId);
        if (!room) return;
        await Message.deleteMany({ roomName: room.name });
        await broadcastStructure();
    }, 'Failed to delete channel.'));

    socket.on('channel:rename', safeSocketHandler(socket, 'channel:rename', async ({ channelId, newName }) => {
        if (socket.user.role !== 'owner')
            return socket.emit('error:permission', 'Owner only.');
        if (!newName?.trim()) return;
        
        const room = await Room.findById(channelId);
        if (!room) return;
        const oldName = room.name;
        const formattedNewName = newName.trim().toLowerCase().replace(/\s+/g, '-');
        
        room.name = formattedNewName;
        await room.save();
        
        await Message.updateMany({ roomName: oldName }, { roomName: formattedNewName });
        await broadcastStructure();
    }, 'Failed to rename channel.'));

    socket.on('channel:toggleReadOnly', safeSocketHandler(socket, 'channel:toggleReadOnly', async ({ channelId }) => {
        if (socket.user.role !== 'owner')
            return socket.emit('error:permission', 'Owner only.');
        const room = await Room.findById(channelId);
        if (!room) return;
        room.isReadOnly = !room.isReadOnly;
        await room.save();
        await broadcastStructure();
        io.to(room.name).emit('room:settings', roomToChannel(room));
        io.to(channelId).emit('room:settings', roomToChannel(room));
        socket.emit('command:response', {
            type: 'success',
            text: `✅ #${room.name} is now ${room.isReadOnly ? 'read-only 🔇' : 'writable ✍️'}`,
        });
    }, 'Failed to update channel settings.'));

    socket.on('channel:toggleLock', safeSocketHandler(socket, 'channel:toggleLock', async ({ channelId }) => {
        if (socket.user.role !== 'owner')
            return socket.emit('error:permission', 'Owner only.');
        const room = await Room.findById(channelId);
        if (!room) return;
        room.isLocked = !room.isLocked;
        await room.save();
        await broadcastStructure();
        io.to(room.name).emit('room:settings', roomToChannel(room));
        io.to(channelId).emit('room:settings', roomToChannel(room));
        socket.emit('command:response', {
            type: 'success',
            text: `✅ #${room.name} is now ${room.isLocked ? 'locked 🔒' : 'unlocked 🔓'}`,
        });
    }, 'Failed to update channel settings.'));

    socket.on('channel:togglePrivate', safeSocketHandler(socket, 'channel:togglePrivate', async ({ channelId }) => {
        if (socket.user.role !== 'owner')
            return socket.emit('error:permission', 'Owner only.');
        const room = await Room.findById(channelId);
        if (!room) return;
        room.isPrivate = !room.isPrivate;
        await room.save();
        await broadcastStructure();
        socket.emit('command:response', {
            type: 'success',
            text: `✅ #${room.name} is now ${room.isPrivate ? 'private 👁️' : 'public 🌐'}`,
        });
    }, 'Failed to update channel settings.'));

     // ── Server Settings ────────────────────────────────────────────
    socket.on('settings:get', safeSocketHandler(socket, 'settings:get', async () => {
        const allowUserChannelCreation = await getServerSetting('allowUserChannelCreation', false);
        socket.emit('settings:update', { allowUserChannelCreation });
    }, 'Failed to get settings.'));

    socket.on('settings:update', safeSocketHandler(socket, 'settings:update', async (payload) => {
        // Validate payload is a non-null object
        if (!payload || typeof payload !== 'object')
            return socket.emit('error:general', 'Invalid settings payload.');

        const { key, value } = payload;

        // Validate key exists
        if (!key)
            return socket.emit('error:general', 'Settings key is required.');

        if (socket.user.role !== 'owner')
            return socket.emit('error:permission', 'Owner only.');

        // Validate allowed keys
        const ALLOWED_KEYS = ['allowUserChannelCreation'];
        if (!ALLOWED_KEYS.includes(key))
            return socket.emit('error:general', `Invalid settings key: ${key}`);

        // Enforce boolean value
        if (typeof value !== 'boolean')
            return socket.emit('error:general', 'Settings value must be a boolean.');

        await ServerSettings.findOneAndUpdate(
            { key },
            { value },
            { upsert: true, new: true }
        );
        await broadcastSettings();
    }, 'Failed to update settings.'));

    // ── Pin / delete message ───────────────────────────────────────
    socket.on('message:pin', safeSocketHandler(socket, 'message:pin', async ({ messageId }) => {
        if (!['owner', 'moderator'].includes(socket.user.role))
            return socket.emit('error:permission', 'Moderators only.');
        const query = socket.currentChannelId ? { _id: socket.currentChannelId } : { name: socket.currentRoom };
        const room = await Room.findOne(query);
        if (!room) return;
        const msg = await Message.findById(messageId);
        if (!msg) return;
        
        // Prevent IDOR: Verify message belongs to the target room
        if (msg.roomName !== room.name) 
            return socket.emit('error:permission', 'Message does not belong to this room.');
        const alreadyPinned = room.pinnedMessages.some(id => id.toString() === messageId);
        if (alreadyPinned) {
            room.pinnedMessages = room.pinnedMessages.filter(id => id.toString() !== messageId);
            await room.save();
            const bc = socket.currentChannelId ? io.to(socket.currentChannelId) : io.to(socket.currentRoom);
            bc.emit('message:unpinned', { id: messageId });
        } else {
            if (room.pinnedMessages.length >= 50)
                return socket.emit('error:general', 'Maximum 50 pinned messages reached.');
            room.pinnedMessages.push(messageId);
            await room.save();
            const bc = socket.currentChannelId ? io.to(socket.currentChannelId) : io.to(socket.currentRoom);
            bc.emit('message:pinned', {
                id: messageId, text: msg.text,
                username: msg.username, pinnedBy: socket.user.username,
            });
        }
    }, 'Failed to pin message.'));

    socket.on('message:delete', safeSocketHandler(socket, 'message:delete', async ({ messageId }) => {
        if (!['owner', 'moderator'].includes(socket.user.role))
            return socket.emit('error:permission', 'Moderators only.');
            
        // Look up message first to verify room ownership
        const targetMsg = await Message.findById(messageId);
        if (!targetMsg) return;
        
        const query = socket.currentChannelId ? { _id: socket.currentChannelId } : { name: socket.currentRoom };
        const resolvedRoom = await Room.findOne(query);
        if (!resolvedRoom || targetMsg.roomName !== resolvedRoom.name)
            return socket.emit('error:permission', 'Message does not belong to this room.');

        const msg = await Message.findByIdAndUpdate(
            messageId, { deleted: true, text: '[message deleted]' }, { new: true }
        );
        if (!msg) return;
        const bc = socket.currentChannelId ? io.to(socket.currentChannelId) : io.to(socket.currentRoom);
        bc.emit('message:deleted', { id: messageId });
    }, 'Failed to delete message.'));

    // ── Edit Message ───────────────────────────────────────────────
    socket.on('message:edit',safeSocketHandler(socket,'message:edit', async ({ channelId, roomName: rName, messageId, newText }) => {
        const trimmed = newText?.trim();
        if (!trimmed) return socket.emit('error:message', 'Cannot edit message to empty text.');

        const msg = await Message.findById(messageId);
        if (!msg) return socket.emit('error:message', 'Message not found.');

        // Only author or owner/moderator can edit
        const isAuthor = msg.userId.toString() === socket.user.id;
        const isMod = ['owner', 'moderator'].includes(socket.user.role);

        if (!isAuthor && !isMod)
            return socket.emit('error:permission', 'You can only edit your own messages.');

        if (msg.text === trimmed)
            return socket.emit('error:message', 'New text is the same as original.');

        // Add to edit history before updating
        const editEntry = {
            originalText: msg.text,
            editedText: trimmed,
            editedAt: new Date(),
            editedBy: isMod && !isAuthor ? socket.user.id : null,
        };

        const updatedMsg = await Message.findByIdAndUpdate(
            messageId,
            {
                text: trimmed,
                editedAt: new Date(),
                $push: { editHistory: editEntry }
            },
            { new: true }
        );

        const payload = {
            id: messageId,
            text: trimmed,
            editedAt: updatedMsg.editedAt,
            hasEditHistory: updatedMsg.editHistory.length > 0,
        };

        const bc = channelId ? io.to(channelId) : io.to(rName);
        bc.emit('message:edited', payload);
    },'Failed to edit message.'));

    socket.on(
        'thread:get',
        safeSocketHandler(
            socket,
            'thread:get',
            async ({ parentMessageId }) => {

                if (!parentMessageId) return;

                const parentMsg = await Message.findById(parentMessageId);
                if (!parentMsg) return socket.emit('error:general', 'Parent message not found.');

                // Prevent IDOR: Check room access
                const room = await Room.findOne({ name: parentMsg.roomName });
                if (!room) return socket.emit('error:permission', 'Forbidden: This thread is unavailable.');
                if (room.isPrivate && socket.user.role === ROLES.MEMBER) {
                    const allowed = room.allowedUsers.map(id => id.toString()).includes(socket.user.id);
                    if (!allowed) return socket.emit('error:permission', 'Forbidden: This thread is in a private channel.');
                }

                const replies = await Message.find({
                    parentMessageId,
                    deleted: false,
                })
                    .sort({ createdAt: 1 })
                    .lean();
                socket.emit('thread:history', {
                    parentMessageId,
                    replies: replies.map((m) => ({
                        id: m._id.toString(),
                        userId: m.userId.toString(),
                        username: m.username,
                        role: m.role,
                        text: m.text,
                        timestamp: m.createdAt,
                        deleted: m.deleted,
                        editedAt: m.editedAt,
                        replyCount: m.replyCount,
                        parentMessageId: m.parentMessageId,
                    })),
                });
            }
        )
    );
    // ── Emoji Reactions ───────────────────────────────────────────
    socket.on(
        'message:reaction',
        safeSocketHandler(
            socket,
            'message:reaction',
            async ({ messageId, emoji }) => {

                const message = await Message.findById(messageId);

                if (!message)
                    return socket.emit('error:general', 'Message not found.');

                let reaction = message.reactions.find(
                    r => r.emoji === emoji
                );

                if (!reaction) {

                    message.reactions.push({
                        emoji,
                        users: [socket.user.username]
                    });

                } else {

                    const alreadyReacted = reaction.users.includes(
                        socket.user.username
                    );

                    if (alreadyReacted) {

                        reaction.users = reaction.users.filter(
                            user => user !== socket.user.username
                        );

                        // remove empty emoji group
                        if (reaction.users.length === 0) {
                            message.reactions = message.reactions.filter(
                                r => r.emoji !== emoji
                            );
                        }

                    } else {
                        reaction.users.push(socket.user.username);
                    }
                }

                await message.save();

                const updatedMessage = await Message.findById(messageId);

                const room = await Room.findOne({
                    name: message.roomName
                });


                if (room) {

                    const payload = {
                        messageId,
                        reactions: updatedMessage.reactions,
                    };

                    // users joined via room id
                    io.to(room._id.toString()).emit(
                        'message:reaction:update',
                        payload
                    );

                    // users joined via room name
                    io.to(message.roomName).emit(
                        'message:reaction:update',
                        payload
                    );
                }

            }
        ),
        'Failed to react to message.'
    );

    // ── Category CRUD ──────────────────────────────────────────────
    socket.on('category:create', safeSocketHandler(socket, 'category:create', async ({ name }) => {
        if (socket.user.role !== 'owner')
            return socket.emit('error:permission', 'Owner only.');
        if (!name?.trim()) return;
        await Room.create({
            name: `${name.trim().toLowerCase().replace(/\s+/g, '-')}-general`,
            description: `Default channel for ${name}`,
            emoji: '💬',
            category: name.trim(),
            createdBy: socket.user.username,
        });
        await broadcastStructure();
        io.emit('room:notification', { text: `📁 Category "${name}" created`, type: 'system' });
    }, 'Failed to create category.'));

    socket.on('category:delete', safeSocketHandler(socket, 'category:delete', async ({ categoryId }) => {
        if (socket.user.role !== 'owner')
            return socket.emit('error:permission', 'Owner only.');
        await Room.deleteMany({ category: categoryId });
        await broadcastStructure();
    }, 'Failed to delete category.'));

    // ── User management ────────────────────────────────────────────
    socket.on('user:setrole', safeSocketHandler(socket, 'user:setrole', async ({ targetId, role }) => {
        if (socket.user.role !== 'owner')
            return socket.emit('error:permission', 'Owner only.');
        if (!['member', 'moderator'].includes(role)) return;
        const target = await User.findById(targetId);
        if (!target || target.role === ROLES.ADMIN) return;
        target.role = role;
        await target.save();
        const ls = [...io.sockets.sockets.values()].find(s => s.user?.id === targetId);
        if (ls) { ls.user.role = role; ls.emit('role:updated', { role }); }
        await broadcastUserList();
        io.emit('room:notification', { text: `🔰 ${target.username} → ${role}`, type: 'system' });
    }, 'Failed to update user role.'));

    socket.on('user:kick', safeSocketHandler(socket, 'user:kick', async ({ targetId }) => {
        if (!['owner', 'moderator'].includes(socket.user.role))
            return socket.emit('error:permission', 'Insufficient permissions.');
        const target = await User.findById(targetId);
        if (!target || target.role === ROLES.ADMIN) return;
        const ts = [...io.sockets.sockets.values()].find(s => s.user?.id === targetId);
        if (ts) { ts.emit('kicked', { by: socket.user.username }); ts.disconnect(true); }
        io.emit('room:notification', { text: `👢 ${target.username} kicked`, type: 'system' });
    }, 'Failed to kick user.'));

    socket.on('user:ban', safeSocketHandler(socket, 'user:ban', async ({ targetId }) => {
        if (socket.user.role !== 'owner')
            return socket.emit('error:permission', 'Owner only.');
        const target = await User.findById(targetId);
        if (!target || target.role === ROLES.ADMIN) return;
        target.banned = true;
        await target.save();
        const ts = [...io.sockets.sockets.values()].find(s => s.user?.id === targetId);
        if (ts) { ts.emit('kicked', { by: `${socket.user.username} (banned)` }); ts.disconnect(true); }
        io.emit('room:notification', { text: `🔨 ${target.username} banned`, type: 'system' });
    }, 'Failed to ban user.'));

    // ── Voice channel ──────────────────────────────────────────────
    socket.on('voice:join', safeSocketHandler(socket, 'voice:join', async ({ channelId, channelName }) => {
        socket.join(`voice:${channelId}`);
        socket.currentVoice = channelId;
        io.to(`voice:${channelId}`).emit('voice:joined', {
            userId: socket.user.id,
            username: socket.user.username,
            role: socket.user.role,
        });
        // Send current member list to joiner
        const voiceSockets = await io.in(`voice:${channelId}`).fetchSockets();
        const members = voiceSockets
            .filter(s => s.user)
            .map(s => ({ id: s.user.id, username: s.user.username, role: s.user.role }));
        socket.emit('voice:members', { channelId, members });
        io.emit('room:notification', {
            text: `🎧 ${socket.user.username} joined the music lounge`, type: 'system',
        });
    }, 'Failed to join voice channel.'));

    socket.on('voice:leave', ({ channelId }) => {
        socket.leave(`voice:${channelId}`);
        socket.currentVoice = null;
        io.to(`voice:${channelId}`).emit('voice:left', { userId: socket.user.id });
    });

    // ── DMs ────────────────────────────────────────────────────────
    socket.on('dm:join', safeSocketHandler(socket, 'dm:join', async ({ otherUserId }) => {
        const convId = [socket.user.id, otherUserId].sort().join('_');
        socket.join(`dm:${convId}`);
        socket.currentDM = convId;
        await DirectMessage.updateMany(
            { conversationId: convId, senderId: { $ne: socket.user.id }, read: false },
            { read: true }
        );
        const otherSocket = [...io.sockets.sockets.values()].find(s => s.user?.id === otherUserId);
        if (otherSocket) otherSocket.emit('dm:read', { conversationId: convId });
    }, 'Failed to open direct message.'));

    socket.on('dm:send', safeSocketHandler(socket, 'dm:send', async ({ toUserId, text, clientId }, callback) => {
        try {
            if (text && text.trim().length > MAX_MESSAGE_LENGTH) {
                if (typeof callback === 'function') {
                    return callback({ error: `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters.`, status: 'failed' });
                }
                return socket.emit('error:general', `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters.`);
            }
            if (clientId) {
                const existingMsg = await DirectMessage.findOne({ clientId });

                if (existingMsg) {
                    if (typeof callback == 'function') {
                        return callback({ status: 'success', id: existingMsg._id.toString() });
                    }
                    return;
                }
            }

            const convId = [toUserId, socket.user.id].sort().join('_');

            let msg;
            try {
                msg = await DirectMessage.create({
                    conversationId: convId,
                    participants: [socket.user.id, toUserId],
                    senderId: socket.user.id,
                    senderUsername: socket.user.username,
                    senderRole: socket.user.role,
                    text,
                    clientId
                });
            } catch (createErr) {
                if (createErr.code === 11000 || createErr.name === 'MongoError' || createErr.name === 'MongoServerError') {
                    msg = await DirectMessage.findOne({ clientId });
                    if (!msg) throw createErr;
                } else {
                    throw createErr;
                }
            }

            const payload = {
                id: msg._id.toString(),
                senderId: socket.user.id,
                senderUsername: socket.user.username,
                senderRole: socket.user.role,
                text,
                timestamp: msg.createdAt,
                read: false,
                clientId
            }

            io.to(`dm:${convId}`).emit('dm:message', payload);

            if (typeof callback === 'function') {
                callback({ status: 'success', id: msg._id.toString() });
            }
        } catch (err) {
            if (typeof callback === 'function') {
                callback({ error: 'Server error', status: 'failed' });
            }
        }
    }));

    socket.on('dm:typing:start', ({ toUserId }) => {
        const convId = [socket.user.id, toUserId].sort().join('_');
        socket.to(`dm:${convId}`).emit('dm:typing', { username: socket.user.username, typing: true });
    });
    socket.on('dm:typing:stop', ({ toUserId }) => {
        const convId = [socket.user.id, toUserId].sort().join('_');
        socket.to(`dm:${convId}`).emit('dm:typing', { username: socket.user.username, typing: false });
    });

    // ── Disconnect ─────────────────────────────────────────────────
    socket.on('disconnect', safeSocketHandler(socket, 'disconnect', async () => {
        // Remove this socket from the user's active-socket set in Redis
        await redisClient.sRem(`user:sockets:${socket.user.id}`, socket.id);
        const socketCount = await redisClient.sCard(`user:sockets:${socket.user.id}`);

        if (socketCount === 0) {
            // Last tab closed — the user is truly offline now
            await redisClient.sRem('users:online', socket.user.id);
            await User.findByIdAndUpdate(socket.user.id, { online: false, socketId: null });

            // Only broadcast "left" notifications when the user has no remaining sessions.
            // If they still have other tabs open, they are still present — do not notify.
            if (socket.currentRoom) {
                io.to(socket.currentRoom).emit('room:notification', {
                    text: `${socket.user.username} left`,
                    type: 'leave',
                });
            }

            if (socket.currentVoice) {
                io.to(`voice:${socket.currentVoice}`).emit('voice:left', {
                    userId: socket.user.id,
                });
            }
        }

        // Always re-broadcast the updated online list so counts stay accurate
        await broadcastUserList();
        console.log(`[-] ${socket.user.username} (${socketCount} session(s) remaining)`);
    }, 'Failed to clean up disconnected user.'));
});

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
