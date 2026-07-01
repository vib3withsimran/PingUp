const mongoose = require('mongoose');
const User = require('../models/User');
const Room = require('../models/Room');
const Message = require('../models/Message');
const DirectMessage = require('../models/DirectMessage');
const { ROLES, hasPermission, ROLE_WEIGHTS } = require('../data/store');
const { processCommand } = require('./commands');
const { messageQueue } = require('../services/messageQueue');
const { 
    safeSocketHandler, 
    broadcastStructure, 
    broadcastUserList, 
    getServerSetting, 
    broadcastSettings, 
    roomToChannel,
    evictUnauthorizedSockets
} = require('../utils/helpers');

const MAX_MESSAGE_LENGTH = 2000;

function setupHandlers(io, socket) {
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
                parentMessageId: m.parentMessageId,
                replyCount: m.replyCount || 0,
            })),
        });
        io.to(roomName).emit('room:notification', {
            text: `${socket.user.username} joined #${roomName}`, type: 'join',
        });
    }, 'Failed to join channel.'));

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
                parentMessageId: m.parentMessageId,
                replyCount: m.replyCount || 0,
            })),
            roomSettings: roomToChannel(room),
        });
    }, 'Failed to join channel.'));

    socket.on('message:send', safeSocketHandler(socket, 'message:send', async ({ roomName, channelId, text, parentMessageId, imageUrl }) => {
        const trimmed = text?.trim();
        if (!trimmed && !imageUrl) return;

        if (trimmed && trimmed.length > MAX_MESSAGE_LENGTH) {
            return socket.emit('error:general', `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters.`);
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

        if (trimmed && trimmed.startsWith('/')) return processCommand(io, socket, resolvedRoom, trimmed);

        const freshUser = await User.findById(socket.user.id);

        if (room.isReadOnly && !hasPermission(freshUser.role, ROLES.ADMIN))
            return socket.emit('error:permission', `#${room.name} is read-only.`);
        if (room.isLocked)
            return socket.emit('error:permission', `#${room.name} is locked.`);

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
        await broadcastStructure(io);
        io.emit('room:notification', { text: `# ${room.name} created`, type: 'system' });
    }, 'Failed to create channel.'));

    socket.on('channel:delete', safeSocketHandler(socket, 'channel:delete', async ({ channelId }) => {
        if (socket.user.role !== 'owner')
            return socket.emit('error:permission', 'Owner only.');
        const room = await Room.findByIdAndDelete(channelId);
        if (!room) return;
        await Message.deleteMany({ roomName: room.name });
        await broadcastStructure(io);
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
        await broadcastStructure(io);
    }, 'Failed to rename channel.'));

    socket.on('channel:toggleReadOnly', safeSocketHandler(socket, 'channel:toggleReadOnly', async ({ channelId }) => {
        if (socket.user.role !== 'owner')
            return socket.emit('error:permission', 'Owner only.');
        const room = await Room.findById(channelId);
        if (!room) return;
        room.isReadOnly = !room.isReadOnly;
        await room.save();
        await broadcastStructure(io);
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
        await broadcastStructure(io);
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
        await evictUnauthorizedSockets(io, room);
        await broadcastStructure(io);
        socket.emit('command:response', {
            type: 'success',
            text: `✅ #${room.name} is now ${room.isPrivate ? 'private 👁️' : 'public 🌐'}`,
        });
    }, 'Failed to update channel settings.'));

    socket.on('settings:get', safeSocketHandler(socket, 'settings:get', async () => {
        const allowUserChannelCreation = await getServerSetting('allowUserChannelCreation', false);
        socket.emit('settings:update', { allowUserChannelCreation });
    }, 'Failed to get settings.'));

    socket.on('settings:update', safeSocketHandler(socket, 'settings:update', async (payload) => {
        if (!payload || typeof payload !== 'object')
            return socket.emit('error:general', 'Invalid settings payload.');
        const { key, value } = payload;
        if (!key)
            return socket.emit('error:general', 'Settings key is required.');
        if (socket.user.role !== 'owner')
            return socket.emit('error:permission', 'Owner only.');
        const ALLOWED_KEYS = ['allowUserChannelCreation'];
        if (!ALLOWED_KEYS.includes(key))
            return socket.emit('error:general', `Invalid settings key: ${key}`);
        if (typeof value !== 'boolean')
            return socket.emit('error:general', 'Settings value must be a boolean.');

        await ServerSettings.findOneAndUpdate({ key }, { value }, { upsert: true, new: true });
        await broadcastSettings(io);
    }, 'Failed to update settings.'));

    socket.on('message:pin', safeSocketHandler(socket, 'message:pin', async ({ messageId }) => {
        if (!['owner', 'moderator'].includes(socket.user.role))
            return socket.emit('error:permission', 'Moderators only.');
        const query = socket.currentChannelId ? { _id: socket.currentChannelId } : { name: socket.currentRoom };
        const room = await Room.findOne(query);
        if (!room) return;
        const msg = await Message.findById(messageId);
        if (!msg) return;
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

    socket.on('message:edit',safeSocketHandler(socket,'message:edit', async ({ channelId, roomName: rName, messageId, newText }) => {
        const trimmed = newText?.trim();
        if (!trimmed) return socket.emit('error:message', 'Cannot edit message to empty text.');

        const msg = await Message.findById(messageId);
        if (!msg) return socket.emit('error:message', 'Message not found.');

        const isAuthor = msg.userId.toString() === socket.user.id;
        const isMod = ['owner', 'moderator'].includes(socket.user.role);

        if (!isAuthor && !isMod)
            return socket.emit('error:permission', 'You can only edit your own messages.');

        if (msg.text === trimmed)
            return socket.emit('error:message', 'New text is the same as original.');

        const editEntry = {
            originalText: msg.text,
            editedText: trimmed,
            editedAt: new Date(),
            editedBy: isMod && !isAuthor ? socket.user.id : null,
        };

        const updatedMsg = await Message.findByIdAndUpdate(
            messageId,
            { text: trimmed, editedAt: new Date(), $push: { editHistory: editEntry } },
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

    socket.on('thread:get', safeSocketHandler(socket, 'thread:get', async ({ parentMessageId }) => {
        if (!parentMessageId) return;
        const parentMsg = await Message.findById(parentMessageId);
        if (!parentMsg) return socket.emit('error:general', 'Parent message not found.');
        const room = await Room.findOne({ name: parentMsg.roomName });
        if (!room) return socket.emit('error:permission', 'Forbidden: This thread is unavailable.');
        if (room.isPrivate && socket.user.role === ROLES.MEMBER) {
            const allowed = room.allowedUsers.map(id => id.toString()).includes(socket.user.id);
            if (!allowed) return socket.emit('error:permission', 'Forbidden: This thread is in a private channel.');
        }

        const replies = await Message.find({ parentMessageId, deleted: false }).sort({ createdAt: 1 }).lean();
        socket.emit('thread:history', {
            parentMessageId,
            replies: replies.map((m) => ({
                id: m._id.toString(), userId: m.userId.toString(), username: m.username,
                role: m.role, text: m.text, timestamp: m.createdAt, deleted: m.deleted,
                editedAt: m.editedAt, replyCount: m.replyCount, parentMessageId: m.parentMessageId,
            })),
        });
    }));

    socket.on('message:reaction', safeSocketHandler(socket, 'message:reaction', async ({ messageId, emoji }) => {
        const message = await Message.findById(messageId);
        if (!message) return socket.emit('error:general', 'Message not found.');

        let reaction = message.reactions.find(r => r.emoji === emoji);
        const userId = socket.user.id;

        if (!reaction) {
            message.reactions.push({ emoji, users: [userId] });
        } else {
            const alreadyReacted = reaction.users.map(u => u.toString()).includes(userId);
            if (alreadyReacted) {
                reaction.users = reaction.users.filter(u => u.toString() !== userId);
                if (reaction.users.length === 0) {
                    message.reactions = message.reactions.filter(r => r.emoji !== emoji);
                }
            } else {
                reaction.users.push(userId);
            }
        }
        await message.save();
        const updatedMessage = await Message.findById(messageId);
        const room = await Room.findOne({ name: message.roomName });
        if (room) {
            const payload = { messageId, reactions: updatedMessage.reactions };
            io.to(room._id.toString()).emit('message:reaction:update', payload);
            io.to(message.roomName).emit('message:reaction:update', payload);
        }
    }, 'Failed to react to message.'));

    socket.on('category:create', safeSocketHandler(socket, 'category:create', async ({ name }) => {
        if (socket.user.role !== 'owner') return socket.emit('error:permission', 'Owner only.');
        if (!name?.trim()) return;
        await Room.create({
            name: `${name.trim().toLowerCase().replace(/\s+/g, '-')}-general`,
            description: `Default channel for ${name}`,
            emoji: '💬',
            category: name.trim(),
            createdBy: socket.user.username,
        });
        await broadcastStructure(io);
        io.emit('room:notification', { text: `📁 Category "${name}" created`, type: 'system' });
    }, 'Failed to create category.'));

    socket.on('category:delete', safeSocketHandler(socket, 'category:delete', async ({ categoryId }) => {
        if (socket.user.role !== 'owner') return socket.emit('error:permission', 'Owner only.');
        await Room.deleteMany({ category: categoryId });
        await broadcastStructure(io);
    }, 'Failed to delete category.'));

    socket.on('user:setrole', safeSocketHandler(socket, 'user:setrole', async ({ targetId, role }) => {
        if (socket.user.role !== 'owner') return socket.emit('error:permission', 'Owner only.');
        if (!['member', 'moderator'].includes(role)) return;
        const target = await User.findById(targetId);
        if (!target) return;
        if (ROLE_WEIGHTS[target.role] >= ROLE_WEIGHTS[socket.user.role])
            return socket.emit('error:permission', 'Cannot act on equal or higher privileged users.');
        target.role = role;
        await target.save();
        const ls = [...io.sockets.sockets.values()].find(s => s.user?.id === targetId);
        if (ls) { ls.user.role = role; ls.emit('role:updated', { role }); }
        await broadcastUserList(io);
        io.emit('room:notification', { text: `🔰 ${target.username} → ${role}`, type: 'system' });
    }, 'Failed to update user role.'));

    socket.on('user:kick', safeSocketHandler(socket, 'user:kick', async ({ targetId }) => {
        if (!['owner', 'moderator'].includes(socket.user.role))
            return socket.emit('error:permission', 'Insufficient permissions.');
        const target = await User.findById(targetId);
        if (!target) return;
        if (ROLE_WEIGHTS[target.role] >= ROLE_WEIGHTS[socket.user.role])
            return socket.emit('error:permission', 'Cannot act on equal or higher privileged users.');
        const ts = [...io.sockets.sockets.values()].find(s => s.user?.id === targetId);
        if (ts) { ts.emit('kicked', { by: socket.user.username }); ts.disconnect(true); }
        io.emit('room:notification', { text: `👢 ${target.username} kicked`, type: 'system' });
    }, 'Failed to kick user.'));

    socket.on('user:ban', safeSocketHandler(socket, 'user:ban', async ({ targetId }) => {
        if (socket.user.role !== 'owner') return socket.emit('error:permission', 'Owner only.');
        const target = await User.findById(targetId);
        if (!target) return;
        if (ROLE_WEIGHTS[target.role] >= ROLE_WEIGHTS[socket.user.role])
            return socket.emit('error:permission', 'Cannot act on equal or higher privileged users.');
        target.banned = true;
        await target.save();
        const ts = [...io.sockets.sockets.values()].find(s => s.user?.id === targetId);
        if (ts) { ts.emit('kicked', { by: `${socket.user.username} (banned)` }); ts.disconnect(true); }
        io.emit('room:notification', { text: `🔨 ${target.username} banned`, type: 'system' });
    }, 'Failed to ban user.'));

    socket.on('voice:join', safeSocketHandler(socket, 'voice:join', async ({ channelId, channelName }) => {
        const room = await Room.findById(channelId);
        if (!room || !room.isVoice) return socket.emit('error:general', 'Invalid voice channel.');
        if (room.isPrivate && socket.user.role === ROLES.MEMBER) {
            const allowed = room.allowedUsers?.map(id => id.toString()).includes(socket.user.id);
            if (!allowed) return socket.emit('error:permission', 'This channel is private.');
        }

        socket.join(`voice:${channelId}`);
        socket.currentVoice = channelId;
        io.to(`voice:${channelId}`).emit('voice:joined', {
            userId: socket.user.id, username: socket.user.username, role: socket.user.role,
        });
        const voiceSockets = await io.in(`voice:${channelId}`).fetchSockets();
        const members = voiceSockets.filter(s => s.user).map(s => ({ id: s.user.id, username: s.user.username, role: s.user.role }));
        socket.emit('voice:members', { channelId, members });
        io.emit('room:notification', { text: `🎧 ${socket.user.username} joined the music lounge`, type: 'system' });
    }, 'Failed to join voice channel.'));

    socket.on('voice:leave', ({ channelId }) => {
        socket.leave(`voice:${channelId}`);
        socket.currentVoice = null;
        io.to(`voice:${channelId}`).emit('voice:left', { userId: socket.user.id });
    });

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
                    if (typeof callback == 'function') return callback({ status: 'success', id: existingMsg._id.toString() });
                    return;
                }
            }

            const convId = [toUserId, socket.user.id].sort().join('_');
            let msg;
            try {
                msg = await DirectMessage.create({
                    conversationId: convId, participants: [socket.user.id, toUserId],
                    senderId: socket.user.id, senderUsername: socket.user.username,
                    senderRole: socket.user.role, text, clientId
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
                id: msg._id.toString(), senderId: socket.user.id, senderUsername: socket.user.username,
                senderRole: socket.user.role, text, timestamp: msg.createdAt, read: false, clientId
            }
            io.to(`dm:${convId}`).emit('dm:message', payload);
            if (typeof callback === 'function') callback({ status: 'success', id: msg._id.toString() });
        } catch (err) {
            if (typeof callback === 'function') callback({ error: 'Server error', status: 'failed' });
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
}

module.exports = {
    setupHandlers
};
