const mongoose = require('mongoose');

// Conversation between exactly two users
// conversationId = sorted([userId1, userId2]).join('_') — always consistent
const directMessageSchema = new mongoose.Schema({
  conversationId: { type: String, required: true, index: true },
  participants:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  senderId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderUsername: { type: String, required: true },
  senderRole:     { type: String, required: true },
  text:           { type: String, required: false, default: '' },
  imageUrl:       { type: String, default: null },
  audioUrl:       { type: String, default: null },
  deleted:        { type: Boolean, default: false },
  read:           { type: Boolean, default: false },
  editReactions: [
    {
      emoji: { type: String },
      users: [{ type: String }]
    }
  ],
  clientId:       { type: String, sparse: true, unique: true },
}, { timestamps: true });

module.exports = mongoose.model('DirectMessage', directMessageSchema);
