process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

// Mock external Redis and Mongoose connections to isolate tests
const originalLoad = Module._load;
Module._load = (request, parent, isMain) => {
  if (request.endsWith('config/redis') || request.endsWith('config/redis.js')) {
    const mockRedisClient = {
      psubscribe: async () => {},
      punsubscribe: async () => {},
      subscribe: async () => {},
      unsubscribe: async () => {},
      publish: async () => {},
      on: () => {},
      off: () => {},
      connect: async () => {},
    };
    return {
      pubClient: mockRedisClient,
      subClient: mockRedisClient,
      redisClient: mockRedisClient,
      redisReady: Promise.resolve(),
    };
  }
  if (request.endsWith('services/messageQueue') || request.endsWith('services/messageQueue.js')) {
    return {
      messageQueue: { add: async () => {} },
    };
  }
  return originalLoad(request, parent, isMain);
};

// Import our server configuration (without triggering mongo/redis connection or server startup)
const { server } = require('../server');
const { generateToken } = require('../middleware/auth');

test('Image Upload Integration Test Suite', async (t) => {
  t.after(async () => {
    Module._load = originalLoad;
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // Start server on a dynamic port
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  const mockUser = { _id: { toString: () => 'mock-user-id' }, username: 'uploader', role: 'member' };
  const validToken = generateToken(mockUser);

  await t.test('POST /api/upload - returns 401 if unauthorized (no token)', async () => {
    const res = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
    });
    const data = await res.json();

    assert.equal(res.status, 401);
    assert.equal(data.error, 'Unauthorized: No token provided');
  });

  await t.test('POST /api/upload - returns 401 if token is invalid', async () => {
    const res = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer invalid-token-value',
      },
    });
    const data = await res.json();

    assert.equal(res.status, 401);
    assert.equal(data.error, 'Unauthorized: Invalid or expired token');
  });

  await t.test('POST /api/upload - uploads valid image files successfully', async () => {
    const formData = new FormData();
    const pngMagicBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x00]);
    const blob = new Blob([pngMagicBytes], { type: 'image/png' });
    formData.append('image', blob, 'test-image.png');

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validToken}`,
      },
      body: formData,
    });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.ok(data.imageUrl.startsWith('/uploads/'));
    assert.ok(data.imageUrl.endsWith('.png'));

    // Clean up created test file on disk to keep repository clean
    const filePath = path.join(__dirname, '..', '..', data.imageUrl.replace(/^\/+/, ''));
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  });

  await t.test('POST /api/upload - rejects non-image extensions (XSS/RCE mitigation)', async () => {
    const formData = new FormData();
    const fileContent = '<h1>Malicious Script</h1>';
    const blob = new Blob([fileContent], { type: 'text/html' });
    formData.append('image', blob, 'exploit.html');

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validToken}`,
      },
      body: formData,
    });
    const data = await res.json();

    assert.equal(res.status, 400);
    assert.equal(data.error, 'Invalid file type. Only JPEG, PNG, GIF, and WEBP images are allowed.');
  });

  await t.test('POST /api/upload - rejects non-image MIME types disguised with image extension', async () => {
    const formData = new FormData();
    const fileContent = 'alert("xss")';
    const blob = new Blob([fileContent], { type: 'text/javascript' });
    formData.append('image', blob, 'exploit.png'); // Renamed extension to disguise script

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validToken}`,
      },
      body: formData,
    });
    const data = await res.json();

    assert.equal(res.status, 400);
    assert.equal(data.error, 'Invalid file type. Only JPEG, PNG, GIF, and WEBP images are allowed.');
  });

  await t.test('POST /api/upload - rejects files with spoofed MIME and extension but invalid content signature', async () => {
    const formData = new FormData();
    const fileContent = 'alert("xss disguised as png")';
    const blob = new Blob([fileContent], { type: 'image/png' });
    formData.append('image', blob, 'exploit.png');

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${validToken}`,
      },
      body: formData,
    });
    const data = await res.json();

    assert.equal(res.status, 400);
    assert.equal(data.error, 'Invalid file content. Uploaded file is not a valid image.');
  });
});
