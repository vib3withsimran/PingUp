const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  roomName: { type: String, required: true, index: true },

  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  username: { type: String, required: true },

  role: { type: String, required: true },

  text:       { type: String, required: false, default: '' },
  imageUrl:   { type: String, default: null },

  deleted: { type: Boolean, default: false },

  pinned: { type: Boolean, default: false },

  editedAt: { type: Date, default: null },

  // NEW: Thread / Reply Support
  parentMessageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message',
    default: null,
    index: true,
  },

  replyCount: {
    type: Number,
    default: 0,
  },

  editHistory: [{
    originalText: { type: String, required: true },

    editedText: { type: String, required: true },

    editedAt: { type: Date, default: Date.now },

    editedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  }],

  reactions: [
    {
      emoji: { type: String },
      users: [{ type: String }]
    }
  ],
  clientId: {
    type: String,
    sparse: true,
    unique: true
  },

}, { timestamps: true });

module.exports = mongoose.model('Message', messageSchema);