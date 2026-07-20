const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const DirectMessage = require('../models/DirectMessage');
const { authHeader } = require('../utils/helpers');

router.get('/:otherUserId', async (req, res) => {
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
            imageUrl: m.imageUrl || null,
            audioUrl: m.audioUrl || null,
            timestamp: m.createdAt,
            read: m.read,
        })));
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/', async (req, res) => {
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
            const lastMsgText = c.lastMessage.audioUrl ? '🎵 Voice note' : (c.lastMessage.imageUrl ? '📷 Photo' : c.lastMessage.text);
            return {
                conversationId: c._id,
                otherUser: other
                    ? { id: other._id.toString(), username: other.username, role: other.role, online: other.online }
                    : null,
                lastMessage: lastMsgText,
                lastMessageTime: c.lastMessage.createdAt,
                unreadCount: unread,
            };
        }));
        res.json(result.filter(r => r.otherUser));
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
