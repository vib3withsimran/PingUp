const { socketAuthMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const { redisClient } = require('../config/redis');
const { setupHandlers } = require('./handlers');
const { broadcastUserList, broadcastStructure, getServerSetting, safeSocketHandler } = require('../utils/helpers');

function initializeSockets(io) {
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

            socket.user.role = dbUser.role;
            socket.data.user = socket.user;
            
            await redisClient.sAdd(`user:sockets:${socket.user.id}`, socket.id);
            await redisClient.sAdd('users:online', socket.user.id);
            await User.findByIdAndUpdate(socket.user.id, { online: true, socketId: socket.id });
            await broadcastUserList(io);

            await broadcastStructure(io);
            
            const allowUserChannelCreation = await getServerSetting('allowUserChannelCreation', false);
            socket.emit('settings:update', { allowUserChannelCreation });
            console.log(`[+] ${socket.user.username} (${socket.user.role})`);
        }catch(err){
            console.error('[connection] setup error:', err);
            socket.emit('error:general', 'Connection setup failed.');
            socket.disconnect();
            return;
        }

        setupHandlers(io, socket);

        socket.on('disconnect', safeSocketHandler(socket, 'disconnect', async () => {
            await redisClient.sRem(`user:sockets:${socket.user.id}`, socket.id);
            const socketCount = await redisClient.sCard(`user:sockets:${socket.user.id}`);

            if (socketCount === 0) {
                await redisClient.sRem('users:online', socket.user.id);
                await User.findByIdAndUpdate(socket.user.id, { online: false, socketId: null });

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

            await broadcastUserList(io);
            console.log(`[-] ${socket.user.username} (${socketCount} session(s) remaining)`);
        }, 'Failed to clean up disconnected user.'));
    });
}

module.exports = {
    initializeSockets
};
