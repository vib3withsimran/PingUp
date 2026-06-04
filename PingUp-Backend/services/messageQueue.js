const { Queue, Worker } = require('bullmq');
const Message = require('../models/Message');
const { ioRedisClient } = require('../config/redis');

const queueName = 'chat-messages';

// Setup BullMQ Queue
const messageQueue = new Queue(queueName, {
    connection: ioRedisClient,
    defaultJobOptions: {
        attempts: 5,
        backoff: {
            type: 'exponential',
            delay: 1000
        },
        removeOnFail: false
    }
});

// Setup Worker to process queue
const messageWorker = new Worker(queueName, async (job) => {
    const { _id, roomName, userId, username, role, text, parentMessageId, imageUrl } = job.data;
    
    try {
        let msg;
        try {
            msg = await Message.create({
                _id,
                roomName,
                userId,
                username,
                role,
                text,
                parentMessageId,
                imageUrl
            });
        } catch (createErr) {
            if (createErr.code === 11000 || createErr.name === 'MongoError' || createErr.name === 'MongoServerError') {
                msg = await Message.findById(_id);
                if (!msg) throw createErr;
            } else {
                throw createErr;
            }
        }

        if (parentMessageId) {
            await Message.findByIdAndUpdate(
                parentMessageId,
                { $inc: { replyCount: 1 } }
            );
        }
        
        return { success: true, messageId: msg._id };
    } catch (error) {
        console.error('Error saving message from queue:', error);
        throw error;
    }
}, {
    connection: ioRedisClient
});

messageWorker.on('completed', job => {
    // console.log(`Job with id ${job.id} has been completed`);
});

messageWorker.on('failed', (job, err) => {
    console.error(`Job with id ${job.id} has failed with error ${err.message}`);
});

module.exports = {
    messageQueue
};
