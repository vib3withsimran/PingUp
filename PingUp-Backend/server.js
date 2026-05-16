require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const mongoose   = require('mongoose');

const User          = require('./models/User');
const Room          = require('./models/Room');
const Message       = require('./models/Message');
const DirectMessage = require('./models/DirectMessage');
const { generateToken, socketAuthMiddleware, verifyToken } = require('./middleware/auth');

const app    = express();
const server = http.createServer(app);
// const io     = new Server(server, {
//   cors: { origin: 'http://localhost:5173', "https://pingup-backend-1.onrender.com": true, "https://pingupsite.onrender.com": true, methods: ['GET', 'POST'] },
// });

// app.use(cors({ origin: 'http://localhost:5173', "https://pingup-backend-1.onrender.com": true, "https://pingupsite.onrender.com": true, credentials: true }));


const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:5173",
      "https://pingupsite.onrender.com"
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});

const allowedOrigins = [
  "http://localhost:5173",
  "https://pingupsite.onrender.com"
];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true
  })
);
app.use(express.json());

// ─── Permissions ──────────────────────────────────────────────────
const PERMISSIONS = {
  owner:     [
    'send_message','create_room','delete_room','rename_room',
    'kick_user','ban_user','promote_user','delete_message',
    'clear_room','pin_message','toggle_readonly','toggle_lock',
    'manage_room_members','make_private',
  ],
  moderator: ['send_message','delete_message','pin_message'],
  member:    ['send_message'],
};

function hasPermission(role, action) {
  return PERMISSIONS[role]?.includes(action) ?? false;
}

function rollRole() {
  return Math.random() < 0.30 ? 'moderator' : 'member';
}

// ─── Broadcast helpers ────────────────────────────────────────────
async function broadcastUserList() {
  const users = await User.find({ online: true });
  io.emit('users:update', users.map(u => u.toSafeObject()));
}

async function broadcastStructure() {
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

function roomToChannel(r) {
  return {
    id:             r._id.toString(),
    name:           r.name,
    description:    r.description,
    emoji:          r.emoji || '💬',
    category:       r.category,
    isPrivate:      r.isPrivate      || false,
    isReadOnly:     r.isReadOnly     || false,
    isLocked:       r.isLocked       || false,
    isVoice:        r.isVoice        || false,
    allowedUsers:   r.allowedUsers?.map(id => id.toString()) || [],
    pinnedMessages: r.pinnedMessages?.map(id => id.toString()) || [],
  };
}

// ─── Auth helper ──────────────────────────────────────────────────
function authHeader(req, res) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token)               { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const decoded = verifyToken(token);
  if (!decoded)             { res.status(401).json({ error: 'Invalid token' }); return null; }
  return decoded;
}

// ─── Seed Default Rooms ───────────────────────────────────────────
async function seedRooms() {
  const defaults = [
    { name: 'general',       description: 'General discussion',     category: '✦ welcome', emoji: '🌿', order: 0 },
    { name: 'announcements', description: 'Official announcements',  category: '✦ welcome', emoji: '📢', order: 1, isReadOnly: true },
    { name: 'rules',         description: 'Server rules',            category: '✦ welcome', emoji: '📋', order: 2, isReadOnly: true },
    { name: 'engineering',   description: 'Engineering discussion',  category: '✦ chat',    emoji: '⚙️',  order: 0 },
    { name: 'random',        description: 'Random chat',             category: '✦ chat',    emoji: '🎲',  order: 1 },
    { name: 'ideas',         description: 'Share ideas',             category: '✦ chat',    emoji: '💡',  order: 2 },
    { name: 'music-lounge',  description: 'Stranger Things music',   category: '✦ chat',    emoji: '🎵',  order: 3, isVoice: true },
    { name: 'admin-only',    description: 'Owner & mods only',       category: '✦ staff',   emoji: '🔒',  order: 0, isPrivate: true },
  ];
  for (const r of defaults) {
    await Room.findOneAndUpdate({ name: r.name }, r, { upsert: true, new: true });
  }
  console.log('✅ Default rooms seeded');
}

// ══════════════════════════════════════════════════════════════════
//  REST ROUTES
// ══════════════════════════════════════════════════════════════════

// ─── Register ─────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, email, displayName } = req.body;
    if (!username?.trim() || !password)
      return res.status(400).json({ error: 'Username and password required.' });

    const exists = await User.findOne({ username: username.trim().toLowerCase() });
    if (exists) return res.status(409).json({ error: 'Username already taken.' });

    const userCount = await User.countDocuments();
    const isFirst   = userCount === 0;
    const role      = isFirst ? 'owner' : 'member';

    const user = await User.create({
      username:    username.trim().toLowerCase(),
      password,
      role,
      isFirst,
      displayName: displayName?.trim() || username.trim(),
      email:       email?.trim() || '',
    });

    const token = generateToken(user);
    res.status(201).json({
      token,
      user: user.toSafeObject(),
      roleMessage: isFirst
        ? '👑 You are the OWNER — full system control granted.'
        : '👋 Welcome! You joined as a member.',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── Login ────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: username?.trim().toLowerCase() });
    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ error: 'Invalid credentials.' });
    if (user.banned)
      return res.status(403).json({ error: 'You have been banned.' });

    user.loginCount += 1;
    await user.save();
    const token = generateToken(user);
    res.json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── Get structure ────────────────────────────────────────────────
app.get('/api/structure', async (req, res) => {
  const decoded = authHeader(req, res);
  if (!decoded) return;
  const me = await User.findById(decoded.id);

  const rooms = await Room.find().sort({ category: 1, order: 1, createdAt: 1 });
  const categoryMap = new Map();
  for (const r of rooms) {
    if (r.isPrivate && me.role === 'member') continue;
    const catKey = r.category || 'general';
    if (!categoryMap.has(catKey))
      categoryMap.set(catKey, { id: `cat-${catKey}`, name: catKey, channels: [] });
    categoryMap.get(catKey).channels.push(roomToChannel(r));
  }
  res.json([...categoryMap.values()]);
});

// ─── Get Rooms (legacy) ───────────────────────────────────────────
app.get('/api/rooms', async (req, res) => {
  const rooms = await Room.find().sort({ createdAt: 1 });
  res.json(rooms.map(r => roomToChannel(r)));
});

// ─── Get Users ────────────────────────────────────────────────────
app.get('/api/users', async (req, res) => {
  const decoded = authHeader(req, res);
  if (!decoded) return;
  const me = await User.findById(decoded.id);
  if (!['owner', 'moderator'].includes(me.role))
    return res.status(403).json({ error: 'Forbidden' });

  const users = await User.find();
  res.json(users.map(u => ({
    id:          u._id.toString(),
    username:    u.username,
    role:        u.role,
    displayName: u.displayName,
    online:      u.online,
    banned:      u.banned || false,
    createdAt:   u.createdAt,
    loginCount:  u.loginCount,
  })));
});

// ─── Update Profile ───────────────────────────────────────────────
app.put('/api/profile', async (req, res) => {
  try {
    const decoded = authHeader(req, res);
    if (!decoded) return;
    const { displayName, email, phone } = req.body;
    const user = await User.findByIdAndUpdate(
      decoded.id, { displayName, email, phone }, { new: true }
    );
    res.json({ user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── DM: history ─────────────────────────────────────────────────
app.get('/api/dm/:otherUserId', async (req, res) => {
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
      id:             m._id.toString(),
      conversationId: m.conversationId,
      senderId:       m.senderId.toString(),
      senderUsername: m.senderUsername,
      senderRole:     m.senderRole,
      text:           m.text,
      timestamp:      m.createdAt,
      read:           m.read,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── DM: conversations list ───────────────────────────────────────
app.get('/api/dm', async (req, res) => {
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
      const other   = await User.findById(otherId).lean();
      const unread  = await DirectMessage.countDocuments({
        conversationId: c._id, senderId: { $ne: myId }, read: false,
      });
      return {
        conversationId:  c._id,
        otherUser:       other
          ? { id: other._id.toString(), username: other.username, role: other.role, online: other.online }
          : null,
        lastMessage:     c.lastMessage.text,
        lastMessageTime: c.lastMessage.createdAt,
        unreadCount:     unread,
      };
    }));
    res.json(result.filter(r => r.otherUser));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════
//  COMMAND PROCESSOR
// ══════════════════════════════════════════════════════════════════
async function processCommand(socket, roomName, text) {
  const [cmd, ...args] = text.slice(1).split(' ');
  const isOwner = socket.user.role === 'owner';
  const isMod   = ['owner', 'moderator'].includes(socket.user.role);

  const ok   = msg => socket.emit('command:response', { type: 'success', text: `✅ ${msg}` });
  const err  = msg => socket.emit('command:response', { type: 'error',   text: `❌ ${msg}` });
  const info = msg => socket.emit('command:response', { type: 'help',    text: msg });
  const perm = msg => socket.emit('error:permission', msg);

  switch (cmd.toLowerCase()) {

    case 'help':
      info([
        '── General ──',
        '/help                            show this list',
        '/online                          list online users',
        '/whoami                          your info',
        '/rooms                           list all channels',
        '',
        '── Moderation (mod+) ──',
        '/delete <msgId>                  delete a message',
        '/pin <msgId>                     pin a message',
        '/kick <user>                     kick a user',
        '',
        '── Admin Only (owner) ──',
        '/newchannel <cat> <name> [emoji]  create channel',
        '/delchannel <name>               delete channel',
        '/renamechannel <old> <new>       rename channel',
        '/newcategory <name>              create category',
        '/readonly <channel>              toggle read-only',
        '/lock <channel>                  toggle locked',
        '/private <channel>              toggle private',
        '/adduser <channel> <user>        allow user to private room',
        '/removeuser <channel> <user>     remove user from private room',
        '/promote <user> <role>           set role (member/moderator)',
        '/ban <user>                      ban user',
        '/reroll <user>                   re-roll role randomly',
        '/clear                           wipe room messages',
        '/stats                           server stats',
      ].join('\n'));
      break;

    case 'online': {
      const users = await User.find({ online: true });
      info(users.map(u => `${u.username} [${u.role}]`).join('\n') || 'No users online');
      break;
    }

    case 'whoami': {
      const user = await User.findById(socket.user.id);
      info(`Username: ${user.username}\nRole: ${user.role}\nLogins: ${user.loginCount}\nJoined: ${user.createdAt.toDateString()}`);
      break;
    }

    case 'rooms': {
      const rooms = await Room.find().sort({ category: 1, name: 1 });
      info(rooms.map(r =>
        `${r.emoji} #${r.name} [${r.category}]${r.isReadOnly ? ' 🔇' : ''}${r.isLocked ? ' 🔒' : ''}${r.isPrivate ? ' 👁️' : ''}${r.isVoice ? ' 🎵' : ''}`
      ).join('\n'));
      break;
    }

    case 'stats': {
      if (!isOwner) return perm('Only the owner can view stats.');
      const [uc, mc, rc, oc] = await Promise.all([
        User.countDocuments(),
        Message.countDocuments({ deleted: false }),
        Room.countDocuments(),
        User.countDocuments({ online: true }),
      ]);
      info(`📊 Server Stats\nUsers: ${uc} (${oc} online)\nChannels: ${rc}\nMessages: ${mc}`);
      break;
    }

    case 'delete': {
      if (!isMod) return perm('Moderators only.');
      const msg = await Message.findByIdAndUpdate(
        args[0], { deleted: true, text: '[message deleted]' }, { new: true }
      );
      if (!msg) return err('Message not found.');
      io.to(roomName).emit('message:deleted', { id: args[0] });
      ok('Message deleted.');
      break;
    }

    case 'pin': {
      if (!isMod) return perm('Moderators only.');
      const msg  = await Message.findById(args[0]);
      if (!msg)  return err('Message not found.');
      const room = await Room.findOne({ name: roomName });
      if (!room) return err('Room not found.');
      const already = room.pinnedMessages.some(id => id.toString() === args[0]);
      if (already) {
        room.pinnedMessages = room.pinnedMessages.filter(id => id.toString() !== args[0]);
        await room.save();
        io.to(roomName).emit('message:unpinned', { id: args[0] });
        ok('Message unpinned.');
      } else {
        room.pinnedMessages.push(args[0]);
        await room.save();
        io.to(roomName).emit('message:pinned', {
          id: args[0], text: msg.text, pinnedBy: socket.user.username,
        });
        ok('Message pinned.');
      }
      break;
    }

    case 'kick': {
      if (!isMod) return perm('Moderators only.');
      const target = await User.findOne({ username: args[0], online: true });
      if (!target) return err('User not found or offline.');
      if (target.role === 'owner') return err('Cannot kick the owner.');
      if (socket.user.role === 'moderator' && target.role !== 'member')
        return err('Moderators can only kick members.');
      const ts = [...io.sockets.sockets.values()].find(s => s.user?.id === target._id.toString());
      if (ts) { ts.emit('kicked', { by: socket.user.username }); ts.disconnect(true); }
      ok(`${args[0]} kicked.`);
      io.emit('room:notification', { text: `👢 ${args[0]} was kicked`, type: 'system' });
      break;
    }

    case 'newchannel': {
      if (!isOwner) return perm('Owner only.');
      const [catName, chName, emoji] = args;
      if (!catName || !chName) return err('Usage: /newchannel <category> <name> [emoji]');
      const exists = await Room.findOne({ name: chName.toLowerCase() });
      if (exists) return err(`#${chName} already exists.`);
      const room = await Room.create({
        name:        chName.toLowerCase().replace(/\s+/g, '-'),
        description: `Created by ${socket.user.username}`,
        emoji:       emoji || '💬',
        category:    catName,
        createdBy:   socket.user.username,
      });
      await broadcastStructure();
      ok(`Channel #${room.name} created in [${catName}].`);
      io.emit('room:notification', { text: `# ${room.name} created`, type: 'system' });
      break;
    }

    case 'delchannel': {
      if (!isOwner) return perm('Owner only.');
      const room = await Room.findOneAndDelete({ name: args[0]?.toLowerCase() });
      if (!room) return err(`#${args[0]} not found.`);
      await Message.deleteMany({ roomName: args[0] });
      await broadcastStructure();
      ok(`#${args[0]} deleted.`);
      break;
    }

    case 'renamechannel': {
      if (!isOwner) return perm('Owner only.');
      const [oldName, newName] = args;
      if (!oldName || !newName) return err('Usage: /renamechannel <old> <new>');
      const room = await Room.findOneAndUpdate(
        { name: oldName.toLowerCase() },
        { name: newName.toLowerCase().replace(/\s+/g, '-') },
        { new: true }
      );
      if (!room) return err(`#${oldName} not found.`);
      await broadcastStructure();
      ok(`#${oldName} → #${newName}.`);
      break;
    }

    case 'newcategory': {
      if (!isOwner) return perm('Owner only.');
      const catName = args.join(' ');
      if (!catName) return err('Usage: /newcategory <name>');
      await Room.create({
        name:        `${catName.toLowerCase().replace(/\s+/g, '-')}-general`,
        description: `Default channel`,
        emoji:       '💬',
        category:    catName,
        createdBy:   socket.user.username,
      });
      await broadcastStructure();
      ok(`Category "${catName}" created.`);
      break;
    }

    case 'readonly': {
      if (!isOwner) return perm('Owner only.');
      const room = await Room.findOne({ name: args[0]?.toLowerCase() });
      if (!room) return err(`#${args[0]} not found.`);
      room.isReadOnly = !room.isReadOnly;
      await room.save();
      await broadcastStructure();
      io.to(room.name).emit('room:settings', roomToChannel(room));
      ok(`#${room.name} is now ${room.isReadOnly ? 'read-only 🔇' : 'writable ✍️'}.`);
      break;
    }

    case 'lock': {
      if (!isOwner) return perm('Owner only.');
      const room = await Room.findOne({ name: args[0]?.toLowerCase() });
      if (!room) return err(`#${args[0]} not found.`);
      room.isLocked = !room.isLocked;
      await room.save();
      await broadcastStructure();
      io.to(room.name).emit('room:settings', roomToChannel(room));
      ok(`#${room.name} is now ${room.isLocked ? 'locked 🔒' : 'unlocked 🔓'}.`);
      break;
    }

    case 'private': {
      if (!isOwner) return perm('Owner only.');
      const room = await Room.findOne({ name: args[0]?.toLowerCase() });
      if (!room) return err(`#${args[0]} not found.`);
      room.isPrivate = !room.isPrivate;
      await room.save();
      await broadcastStructure();
      ok(`#${room.name} is now ${room.isPrivate ? 'private 👁️' : 'public 🌐'}.`);
      break;
    }

    case 'adduser': {
      if (!isOwner) return perm('Owner only.');
      const [chName, uname] = args;
      const room   = await Room.findOne({ name: chName?.toLowerCase() });
      const target = await User.findOne({ username: uname });
      if (!room)   return err(`#${chName} not found.`);
      if (!target) return err(`User "${uname}" not found.`);
      if (!room.allowedUsers.includes(target._id)) {
        room.allowedUsers.push(target._id);
        await room.save();
      }
      await broadcastStructure();
      ok(`${uname} added to #${chName}.`);
      break;
    }

    case 'removeuser': {
      if (!isOwner) return perm('Owner only.');
      const [chName, uname] = args;
      const room   = await Room.findOne({ name: chName?.toLowerCase() });
      const target = await User.findOne({ username: uname });
      if (!room)   return err(`#${chName} not found.`);
      if (!target) return err(`User "${uname}" not found.`);
      room.allowedUsers = room.allowedUsers.filter(id => id.toString() !== target._id.toString());
      await room.save();
      await broadcastStructure();
      ok(`${uname} removed from #${chName}.`);
      break;
    }

    case 'promote': {
      if (!isOwner) return perm('Owner only.');
      const [targetName, newRole] = args;
      if (!['moderator', 'member'].includes(newRole))
        return err('Role must be: moderator or member');
      const targetUser = await User.findOneAndUpdate(
        { username: targetName }, { role: newRole }, { new: true }
      );
      if (!targetUser) return err('User not found.');
      const ls = [...io.sockets.sockets.values()].find(s => s.user?.id === targetUser._id.toString());
      if (ls) { ls.user.role = newRole; ls.emit('role:updated', { role: newRole }); }
      await broadcastUserList();
      ok(`${targetName} is now ${newRole}.`);
      io.emit('room:notification', { text: `🔰 ${targetName} → ${newRole}`, type: 'system' });
      break;
    }

    case 'ban': {
      if (!isOwner) return perm('Owner only.');
      const target = await User.findOne({ username: args[0] });
      if (!target) return err('User not found.');
      if (target.role === 'owner') return err('Cannot ban the owner.');
      target.banned = true;
      await target.save();
      const ts = [...io.sockets.sockets.values()].find(s => s.user?.id === target._id.toString());
      if (ts) { ts.emit('kicked', { by: `${socket.user.username} (banned)` }); ts.disconnect(true); }
      ok(`${args[0]} banned.`);
      io.emit('room:notification', { text: `🔨 ${args[0]} was banned`, type: 'system' });
      break;
    }

    case 'reroll': {
      if (!isOwner) return perm('Owner only.');
      const target = await User.findOne({ username: args[0] });
      if (!target) return err('User not found.');
      if (target.role === 'owner') return err('Cannot reroll the owner.');
      const newRole = rollRole();
      target.role = newRole;
      await target.save();
      const ls = [...io.sockets.sockets.values()].find(s => s.user?.id === target._id.toString());
      if (ls) { ls.user.role = newRole; ls.emit('role:updated', { role: newRole }); }
      await broadcastUserList();
      ok(`🎲 ${args[0]} rerolled → ${newRole.toUpperCase()}`);
      io.emit('room:notification', { text: `🎲 ${args[0]}'s role rerolled to ${newRole}`, type: 'system' });
      break;
    }

    case 'clear': {
      if (!isOwner) return perm('Owner only.');
      await Message.updateMany({ roomName }, { deleted: true, text: '[message deleted]' });
      io.to(roomName).emit('room:cleared');
      ok(`#${roomName} cleared.`);
      break;
    }

    default:
      err(`Unknown command: /${cmd}. Type /help`);
  }
}

// ══════════════════════════════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════════════════════════════
io.use(socketAuthMiddleware);

io.on('connection', async (socket) => {
  const dbUser = await User.findById(socket.user.id);
  if (!dbUser) return socket.disconnect();
  if (dbUser.banned) {
    socket.emit('kicked', { by: 'server (banned)' });
    return socket.disconnect();
  }

  // Sync role from DB
  socket.user.role = dbUser.role;

  await User.findByIdAndUpdate(socket.user.id, { online: true, socketId: socket.id });
  await broadcastUserList();

  // Send filtered structure on connect
  const rooms = await Room.find().sort({ category: 1, order: 1, createdAt: 1 });
  const categoryMap = new Map();
  for (const r of rooms) {
    if (r.isPrivate && dbUser.role === 'member') continue;
    const catKey = r.category || 'general';
    if (!categoryMap.has(catKey))
      categoryMap.set(catKey, { id: `cat-${catKey}`, name: catKey, channels: [] });
    categoryMap.get(catKey).channels.push(roomToChannel(r));
  }
  socket.emit('structure:update', [...categoryMap.values()]);
  console.log(`[+] ${socket.user.username} (${socket.user.role})`);

  // ── Join channel (by name) ─────────────────────────────────────
  socket.on('room:join', async ({ roomName }) => {
    const room = await Room.findOne({ name: roomName });
    if (!room) return socket.emit('error:general', 'Channel not found.');
    if (room.isPrivate && dbUser.role === 'member') {
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
        id: m._id.toString(), userId: m.userId.toString(),
        username: m.username, role: m.role, text: m.text,
        timestamp: m.createdAt, deleted: m.deleted,
        pinned: pinnedIds.includes(m._id.toString()),
        editedAt: m.editedAt,
        editHistory: m.editHistory,
      })),
      roomSettings: roomToChannel(room),
    });
    io.to(roomName).emit('room:notification', {
      text: `${socket.user.username} joined #${roomName}`, type: 'join',
    });
  });

  // ── Join channel (by ID) ───────────────────────────────────────
  socket.on('channel:join', async ({ channelId }) => {
    const room = await Room.findById(channelId);
    if (!room) return socket.emit('error:general', 'Channel not found.');
    if (room.isPrivate && dbUser.role === 'member') {
      const allowed = room.allowedUsers.map(id => id.toString()).includes(socket.user.id);
      if (!allowed) return socket.emit('error:permission', 'This channel is private.');
    }
    ;[...socket.rooms].forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join(channelId);
    socket.currentRoom      = room.name;
    socket.currentChannelId = channelId;
    const history = await Message.find({ roomName: room.name, deleted: false })
      .sort({ createdAt: -1 }).limit(50).lean();
    const pinnedIds = room.pinnedMessages.map(id => id.toString());
    socket.emit('channel:history', {
      channelId,
      messages: history.reverse().map(m => ({
        id: m._id.toString(), userId: m.userId.toString(),
        username: m.username, role: m.role, text: m.text,
        timestamp: m.createdAt, deleted: m.deleted,
        pinned: pinnedIds.includes(m._id.toString()),
        editedAt: m.editedAt,
        editHistory: m.editHistory,
      })),
      roomSettings: roomToChannel(room),
    });
  });

  // ── Send message ───────────────────────────────────────────────
  socket.on('message:send', async ({ roomName, channelId, text }) => {
    const trimmed = text?.trim();
    if (!trimmed) return;

    let resolvedRoom = roomName;
    let room = null;
    if (channelId) {
      room = await Room.findById(channelId);
      resolvedRoom = room?.name;
    } else {
      room = await Room.findOne({ name: roomName });
    }
    if (!resolvedRoom || !room) return;

    if (trimmed.startsWith('/')) return processCommand(socket, resolvedRoom, trimmed);

    const freshUser = await User.findById(socket.user.id);
    if (room.isReadOnly && freshUser.role !== 'owner')
      return socket.emit('error:permission', `#${room.name} is read-only.`);
    if (room.isLocked)
      return socket.emit('error:permission', `#${room.name} is locked.`);
    if (!hasPermission(freshUser.role, 'send_message'))
      return socket.emit('error:permission', 'You cannot send messages.');

    const msg = await Message.create({
      roomName: resolvedRoom, userId: socket.user.id,
      username: socket.user.username, role: freshUser.role, text: trimmed,
    });

    const payload = {
      id: msg._id.toString(), userId: socket.user.id,
      username: socket.user.username, role: freshUser.role,
      text: trimmed, timestamp: msg.createdAt, deleted: false, pinned: false,
    };

    io.to(resolvedRoom).emit('message:new', payload);
    if (channelId && channelId !== resolvedRoom) {
      io.to(channelId).emit('message:new', payload);
    }
  });

  // ── Typing ─────────────────────────────────────────────────────
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

  // ── Owner: channel CRUD ────────────────────────────────────────
  socket.on('channel:create', async ({ categoryId, name, description, emoji }) => {
    if (socket.user.role !== 'owner')
      return socket.emit('error:permission', 'Owner only.');
    if (!name?.trim()) return;
    const exists = await Room.findOne({ name: name.trim().toLowerCase() });
    if (exists) return socket.emit('error:general', 'Channel name already exists.');
    const room = await Room.create({
      name:        name.trim().toLowerCase().replace(/\s+/g, '-'),
      description: description?.trim() || '',
      emoji:       emoji || '💬',
      category:    categoryId,
      createdBy:   socket.user.username,
    });
    await broadcastStructure();
    io.emit('room:notification', { text: `# ${room.name} created`, type: 'system' });
  });

  socket.on('channel:delete', async ({ channelId }) => {
    if (socket.user.role !== 'owner')
      return socket.emit('error:permission', 'Owner only.');
    const room = await Room.findByIdAndDelete(channelId);
    if (!room) return;
    await Message.deleteMany({ roomName: room.name });
    await broadcastStructure();
  });

  socket.on('channel:rename', async ({ channelId, newName }) => {
    if (socket.user.role !== 'owner')
      return socket.emit('error:permission', 'Owner only.');
    if (!newName?.trim()) return;
    const room = await Room.findByIdAndUpdate(
      channelId,
      { name: newName.trim().toLowerCase().replace(/\s+/g, '-') },
      { new: true }
    );
    if (room) await broadcastStructure();
  });

  socket.on('channel:toggleReadOnly', async ({ channelId }) => {
    if (socket.user.role !== 'owner')
      return socket.emit('error:permission', 'Owner only.');
    const room = await Room.findById(channelId);
    if (!room) return;
    room.isReadOnly = !room.isReadOnly;
    await room.save();
    await broadcastStructure();
    io.to(room.name).emit('room:settings', roomToChannel(room));
    io.to(channelId).emit('room:settings', roomToChannel(room));
    socket.emit('command:response', {
      type: 'success',
      text: `✅ #${room.name} is now ${room.isReadOnly ? 'read-only 🔇' : 'writable ✍️'}`,
    });
  });

  socket.on('channel:toggleLock', async ({ channelId }) => {
    if (socket.user.role !== 'owner')
      return socket.emit('error:permission', 'Owner only.');
    const room = await Room.findById(channelId);
    if (!room) return;
    room.isLocked = !room.isLocked;
    await room.save();
    await broadcastStructure();
    io.to(room.name).emit('room:settings', roomToChannel(room));
    io.to(channelId).emit('room:settings', roomToChannel(room));
    socket.emit('command:response', {
      type: 'success',
      text: `✅ #${room.name} is now ${room.isLocked ? 'locked 🔒' : 'unlocked 🔓'}`,
    });
  });

  socket.on('channel:togglePrivate', async ({ channelId }) => {
    if (socket.user.role !== 'owner')
      return socket.emit('error:permission', 'Owner only.');
    const room = await Room.findById(channelId);
    if (!room) return;
    room.isPrivate = !room.isPrivate;
    await room.save();
    await broadcastStructure();
    socket.emit('command:response', {
      type: 'success',
      text: `✅ #${room.name} is now ${room.isPrivate ? 'private 👁️' : 'public 🌐'}`,
    });
  });

  // ── Pin / delete message ───────────────────────────────────────
  socket.on('message:pin', async ({ channelId, roomName: rName, messageId }) => {
    if (!['owner', 'moderator'].includes(socket.user.role))
      return socket.emit('error:permission', 'Moderators only.');
    const query = channelId ? { _id: channelId } : { name: rName };
    const room  = await Room.findOne(query);
    if (!room) return;
    const msg = await Message.findById(messageId);
    if (!msg) return;
    const alreadyPinned = room.pinnedMessages.some(id => id.toString() === messageId);
    if (alreadyPinned) {
      room.pinnedMessages = room.pinnedMessages.filter(id => id.toString() !== messageId);
      await room.save();
      const bc = channelId ? io.to(channelId) : io.to(rName);
      bc.emit('message:unpinned', { id: messageId });
    } else {
      if (room.pinnedMessages.length >= 50)
        return socket.emit('error:general', 'Maximum 50 pinned messages reached.');
      room.pinnedMessages.push(messageId);
      await room.save();
      const bc = channelId ? io.to(channelId) : io.to(rName);
      bc.emit('message:pinned', {
        id: messageId, text: msg.text,
        username: msg.username, pinnedBy: socket.user.username,
      });
    }
  });

  socket.on('message:delete', async ({ channelId, roomName: rName, messageId }) => {
    if (!['owner', 'moderator'].includes(socket.user.role))
      return socket.emit('error:permission', 'Moderators only.');
    const msg = await Message.findByIdAndUpdate(
      messageId, { deleted: true, text: '[message deleted]' }, { new: true }
    );
    if (!msg) return;
    const bc = channelId ? io.to(channelId) : io.to(rName);
    bc.emit('message:deleted', { id: messageId });
  });

  // ── Edit Message ───────────────────────────────────────────────
  socket.on('message:edit', async ({ channelId, roomName: rName, messageId, newText }) => {
    const trimmed = newText?.trim();
    if (!trimmed) return socket.emit('error:message', 'Cannot edit message to empty text.');

    const msg = await Message.findById(messageId);
    if (!msg) return socket.emit('error:message', 'Message not found.');

    // Only author or owner/moderator can edit
    const isAuthor = msg.userId.toString() === socket.user.id;
    const isMod = ['owner', 'moderator'].includes(socket.user.role);
    
    if (!isAuthor && !isMod)
      return socket.emit('error:permission', 'You can only edit your own messages.');

    if (msg.text === trimmed)
      return socket.emit('error:message', 'New text is the same as original.');

    // Add to edit history before updating
    const editEntry = {
      originalText: msg.text,
      editedText: trimmed,
      editedAt: new Date(),
      editedBy: isMod && !isAuthor ? socket.user.id : null,
    };

    const updatedMsg = await Message.findByIdAndUpdate(
      messageId,
      {
        text: trimmed,
        editedAt: new Date(),
        $push: { editHistory: editEntry }
      },
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
  });

  // ── Category CRUD ──────────────────────────────────────────────
  socket.on('category:create', async ({ name }) => {
    if (socket.user.role !== 'owner')
      return socket.emit('error:permission', 'Owner only.');
    if (!name?.trim()) return;
    await Room.create({
      name:        `${name.trim().toLowerCase().replace(/\s+/g, '-')}-general`,
      description: `Default channel for ${name}`,
      emoji:       '💬',
      category:    name.trim(),
      createdBy:   socket.user.username,
    });
    await broadcastStructure();
    io.emit('room:notification', { text: `📁 Category "${name}" created`, type: 'system' });
  });

  socket.on('category:delete', async ({ categoryId }) => {
    if (socket.user.role !== 'owner')
      return socket.emit('error:permission', 'Owner only.');
    await Room.deleteMany({ category: categoryId });
    await broadcastStructure();
  });

  // ── User management ────────────────────────────────────────────
  socket.on('user:setrole', async ({ targetId, role }) => {
    if (socket.user.role !== 'owner')
      return socket.emit('error:permission', 'Owner only.');
    if (!['member', 'moderator'].includes(role)) return;
    const target = await User.findById(targetId);
    if (!target || target.role === 'owner') return;
    target.role = role;
    await target.save();
    const ls = [...io.sockets.sockets.values()].find(s => s.user?.id === targetId);
    if (ls) { ls.user.role = role; ls.emit('role:updated', { role }); }
    await broadcastUserList();
    io.emit('room:notification', { text: `🔰 ${target.username} → ${role}`, type: 'system' });
  });

  socket.on('user:kick', async ({ targetId }) => {
    if (!['owner', 'moderator'].includes(socket.user.role))
      return socket.emit('error:permission', 'Insufficient permissions.');
    const target = await User.findById(targetId);
    if (!target || target.role === 'owner') return;
    const ts = [...io.sockets.sockets.values()].find(s => s.user?.id === targetId);
    if (ts) { ts.emit('kicked', { by: socket.user.username }); ts.disconnect(true); }
    io.emit('room:notification', { text: `👢 ${target.username} kicked`, type: 'system' });
  });

  socket.on('user:ban', async ({ targetId }) => {
    if (socket.user.role !== 'owner')
      return socket.emit('error:permission', 'Owner only.');
    const target = await User.findById(targetId);
    if (!target || target.role === 'owner') return;
    target.banned = true;
    await target.save();
    const ts = [...io.sockets.sockets.values()].find(s => s.user?.id === targetId);
    if (ts) { ts.emit('kicked', { by: `${socket.user.username} (banned)` }); ts.disconnect(true); }
    io.emit('room:notification', { text: `🔨 ${target.username} banned`, type: 'system' });
  });

  // ── Voice channel ──────────────────────────────────────────────
  socket.on('voice:join', async ({ channelId, channelName }) => {
    socket.join(`voice:${channelId}`);
    socket.currentVoice = channelId;
    io.to(`voice:${channelId}`).emit('voice:joined', {
      userId:   socket.user.id,
      username: socket.user.username,
      role:     socket.user.role,
    });
    // Send current member list to joiner
    const voiceSockets = await io.in(`voice:${channelId}`).fetchSockets();
    const members = voiceSockets
      .filter(s => s.user)
      .map(s => ({ id: s.user.id, username: s.user.username, role: s.user.role }));
    socket.emit('voice:members', { channelId, members });
    io.emit('room:notification', {
      text: `🎧 ${socket.user.username} joined the music lounge`, type: 'system',
    });
  });

  socket.on('voice:leave', ({ channelId }) => {
    socket.leave(`voice:${channelId}`);
    socket.currentVoice = null;
    io.to(`voice:${channelId}`).emit('voice:left', { userId: socket.user.id });
  });

  // ── DMs ────────────────────────────────────────────────────────
  socket.on('dm:join', async ({ otherUserId }) => {
    const convId = [socket.user.id, otherUserId].sort().join('_');
    socket.join(`dm:${convId}`);
    socket.currentDM = convId;
    await DirectMessage.updateMany(
      { conversationId: convId, senderId: { $ne: socket.user.id }, read: false },
      { read: true }
    );
    const otherSocket = [...io.sockets.sockets.values()].find(s => s.user?.id === otherUserId);
    if (otherSocket) otherSocket.emit('dm:read', { conversationId: convId });
  });

  socket.on('dm:send', async ({ toUserId, text }) => {
    const trimmed = text?.trim();
    if (!trimmed) return;
    const toUser = await User.findById(toUserId);
    if (!toUser) return socket.emit('error:general', 'User not found.');
    const convId    = [socket.user.id, toUserId].sort().join('_');
    const freshUser = await User.findById(socket.user.id);
    const msg = await DirectMessage.create({
      conversationId: convId,
      participants:   [socket.user.id, toUserId],
      senderId:       socket.user.id,
      senderUsername: socket.user.username,
      senderRole:     freshUser.role,
      text:           trimmed,
      read:           false,
    });
    const payload = {
      id:             msg._id.toString(),
      conversationId: convId,
      senderId:       socket.user.id,
      senderUsername: socket.user.username,
      senderRole:     freshUser.role,
      text:           trimmed,
      timestamp:      msg.createdAt,
      read:           false,
    };
    io.to(`dm:${convId}`).emit('dm:message', payload);
    const rs = [...io.sockets.sockets.values()].find(s => s.user?.id === toUserId);
    if (rs && rs.currentDM !== convId) {
      rs.emit('dm:notification', {
        from:           socket.user.username,
        fromId:         socket.user.id,
        conversationId: convId,
        preview:        trimmed.slice(0, 60),
      });
    }
  });

  socket.on('dm:typing:start', ({ toUserId }) => {
    const convId = [socket.user.id, toUserId].sort().join('_');
    socket.to(`dm:${convId}`).emit('dm:typing', { username: socket.user.username, typing: true });
  });
  socket.on('dm:typing:stop', ({ toUserId }) => {
    const convId = [socket.user.id, toUserId].sort().join('_');
    socket.to(`dm:${convId}`).emit('dm:typing', { username: socket.user.username, typing: false });
  });

  // ── Disconnect ─────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    await User.findByIdAndUpdate(socket.user.id, { online: false, socketId: null });

    // Notify text channel
    if (socket.currentRoom) {
      io.to(socket.currentRoom).emit('room:notification', {
        text: `${socket.user.username} left`,
        type: 'leave',
      });
    }

    // Notify voice channel
    if (socket.currentVoice) {
      io.to(`voice:${socket.currentVoice}`).emit('voice:left', {
        userId: socket.user.id,
      });
    }

    await broadcastUserList();
    console.log(`[-] ${socket.user.username}`);
  });
});

// ─── Connect & Start ──────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('✅ MongoDB connected');
    await seedRooms();
    server.listen(process.env.PORT || 3001, () =>
      console.log(`🚀 Server on http://localhost:${process.env.PORT || 3001}`)
    );
  })
  .catch(err => { console.error('MongoDB error:', err); process.exit(1); });
