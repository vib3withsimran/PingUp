const { ROLES } = require('../data/store');
const User = require('../models/User');
const Room = require('../models/Room');
const ServerSettings = require('../models/ServerSettings');
const { verifyToken } = require('../middleware/auth');
const { redisClient } = require('../config/redis');

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

async function broadcastUserList(io) {
    const onlineUserIds = await redisClient.sMembers('users:online');
    if (onlineUserIds.length === 0) {
        io.emit('users:update', []);
        return;
    }
    const users = await User.find({ _id: { $in: onlineUserIds } });
    io.emit('users:update', users.map(u => u.toSafeObject()));
}

async function evictUnauthorizedSockets(io, room) {
    if (!room.isPrivate) return;

    const roomIdStr = room._id.toString();

    const [socketsByIdArr, socketsByNameArr] = await Promise.all([
        io.in(roomIdStr).fetchSockets(),
        io.in(room.name).fetchSockets(),
    ]);

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
        if (isOwnerOrAdmin) continue;

        const isAllowed = allowedSet.has(user?.id?.toString());
        if (!isAllowed) {
            s.leave(roomIdStr);
            s.leave(room.name);
            s.emit('channel:kicked', {
                channelId: roomIdStr,
                reason: 'This channel has been made private.',
            });
        }
    }
}

async function broadcastStructure(io) {
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

async function getServerSetting(key, defaultValue) {
    try {
        const setting = await ServerSettings.findOne({ key });
        return setting ? setting.value === true : defaultValue;
    } catch {
        return defaultValue;
    }
}

async function broadcastSettings(io) {
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

module.exports = {
    rollRole,
    safeSocketHandler,
    broadcastUserList,
    evictUnauthorizedSockets,
    broadcastStructure,
    getServerSetting,
    broadcastSettings,
    roomToChannel,
    authHeader
};
