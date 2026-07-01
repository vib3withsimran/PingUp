const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Room = require('../models/Room');
const { ROLES, hasPermission } = require('../data/store');
const { authHeader, roomToChannel } = require('../utils/helpers');

router.get('/structure', async (req, res) => {
    const decoded = authHeader(req, res);
    if (!decoded) return;

    const me = await User.findById(decoded.id);
    if (!me) return res.status(401).json({ error: 'User not found.' });

    const rooms = await Room.find().sort({ category: 1, order: 1, createdAt: 1 });
    const categoryMap = new Map();

    for (const r of rooms) {
      if (r.isPrivate) {
        const isModOrOwner = hasPermission(me.role, ROLES.MODERATOR);

        const isAllowedUser = r.allowedUsers?.some(
          id => id.toString() === me._id.toString()
        );

        if (!isModOrOwner && !isAllowedUser) {
          continue;
        }
      }

      const catKey = r.category || 'general';

      if (!categoryMap.has(catKey)) {
        categoryMap.set(catKey, {
          id: `cat-${catKey}`,
          name: catKey,
          channels: []
        });
      }

      categoryMap.get(catKey).channels.push(roomToChannel(r));
    }

    res.json([...categoryMap.values()]);
});

router.get('/rooms', async (req, res) => {
    const decoded = authHeader(req, res);
    if (!decoded) return;

    const me = await User.findById(decoded.id);
    if (!me) return res.status(401).json({ error: 'User not found.' });

    const rooms = await Room.find().sort({ createdAt: 1 });

    const filteredRooms = rooms.filter(room => {
      if (!room.isPrivate) return true;

      if (hasPermission(me.role, ROLES.MODERATOR)) {
        return true;
      }

      return room.allowedUsers?.some(
        userId => userId.toString() === me._id.toString()
      );
    });

    res.json(filteredRooms.map(r => roomToChannel(r)));
});

module.exports = router;
