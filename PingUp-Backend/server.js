require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const cors = require('cors');
const mongoose = require('mongoose');

const { pubClient, subClient, redisReady } = require('./config/redis');
const Room = require('./models/Room');
const { uploadDir } = require('./middleware/upload');

const authRoutes = require('./routes/auth');
const uploadRoutes = require('./routes/upload');
const usersRoutes = require('./routes/users');
const channelsRoutes = require('./routes/channels');
const dmRoutes = require('./routes/dm');
const messagesRoutes = require('./routes/messages');
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
// Serve uploaded images
app.use('/uploads', express.static(uploadDir));

// Routes
app.use('/api', authRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/users', usersRoutes);
app.use('/api', channelsRoutes); // /api/structure, /api/rooms
app.use('/api/dm', dmRoutes);
app.use('/api/messages', messagesRoutes);

// Socket.IO
initializeSockets(io);

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
