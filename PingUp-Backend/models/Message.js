const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  roomName:  { type: String, required: true, index: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username:  { type: String, required: true },
  role:      { type: String, required: true },
  text:      { type: String, required: true },
  deleted:   { type: Boolean, default: false },
  editedAt:  { type: Date, default: null },
  editHistory: [{
    originalText: { type: String, required: true },
    editedText:   { type: String, required: true },
    editedAt:     { type: Date, default: Date.now },
    editedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  }],
}, { timestamps: true });

module.exports = mongoose.model('Message', messageSchema);
