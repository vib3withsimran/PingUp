const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Message = require('../models/Message');
const DirectMessage = require('../models/DirectMessage');
const Room = require('../models/Room');
const { authHeader } = require('../utils/helpers');
const { ROLES } = require('../data/store');

router.get('/', async (req, res) => {
    try {
        const decoded = authHeader(req, res);
        if (!decoded) return;

        const { q, channelId, dmId } = req.query;
        if (!q) {
            return res.json([]);
        }

        const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const queryRegex = new RegExp(escapedQ, 'i');
        
        if (channelId) {
            const room = await Room.findById(channelId);
            if (!room) {
                return res.status(404).json({ error: 'Channel not found' });
            }

            if (room.isPrivate && decoded.role === ROLES.MEMBER) {
                const allowed = room.allowedUsers.map(id => id.toString()).includes(decoded.id);
                if (!allowed) return res.status(403).json({ error: 'Access denied' });
            }

            const messages = await Message.find({
                roomName: room.name,
                deleted: false,
                text: queryRegex
            }).sort({ createdAt: -1 }).limit(50).lean();

            return res.json(messages.map(m => ({
                id: m._id.toString(),
                userId: m.userId.toString(),
                username: m.username,
                role: m.role,
                text: m.text,
                timestamp: m.createdAt,
                editedAt: m.editedAt,
                parentMessageId: m.parentMessageId,
            })));
        } else if (dmId) {
            if (!dmId.includes(decoded.id)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const messages = await DirectMessage.find({
                conversationId: dmId,
                deleted: false,
                text: queryRegex
            }).sort({ createdAt: -1 }).limit(50).lean();

            return res.json(messages.map(m => ({
                id: m._id.toString(),
                conversationId: m.conversationId,
                senderId: m.senderId.toString(),
                senderUsername: m.senderUsername,
                senderRole: m.senderRole,
                text: m.text,
                timestamp: m.createdAt,
                read: m.read,
            })));
        }

        res.json([]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
