process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

test('verifyToken restricts accepted JWT algorithms to HS256', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret';

  const originalLoad = Module._load;
  let capturedOptions;

  delete require.cache[require.resolve('../middleware/auth')];

  Module._load = (request, parent, isMain) => {
    if (request === 'jsonwebtoken') {
      return {
        sign: () => 'signed-token',
        verify: (_token, _secret, options) => {
          capturedOptions = options;
          return { id: 'user-1', username: 'test-user', role: 'member', purpose: 'access' };
        }
      };
    }

    return originalLoad(request, parent, isMain);
  };

  try {
    const { verifyToken } = require('../middleware/auth');

    const decoded = verifyToken('signed-token');

    assert.deepEqual(decoded, {
      id: 'user-1',
      username: 'test-user',
      role: 'member',
      purpose: 'access'
    });
    assert.deepEqual(capturedOptions, { algorithms: ['HS256'] });
  } finally {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
    Module._load = originalLoad;
    delete require.cache[require.resolve('../middleware/auth')];
  }
});

test('first test does not leak JWT_SECRET into process.env', () => {
  const beforeAll = process.env.JWT_SECRET;

  process.env.JWT_SECRET = 'leak-check-probe';

  const originalLoad = Module._load;
  Module._load = (request, parent, isMain) => {
    if (request === 'jsonwebtoken') {
      return {
        sign: () => 'signed-token',
        verify: () => ({ id: 'user-1', username: 'test-user', role: 'member', purpose: 'access' })
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../middleware/auth')];
    const { verifyToken } = require('../middleware/auth');
    verifyToken('signed-token');
  } finally {
    if (beforeAll === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = beforeAll;
    }
    Module._load = originalLoad;
    delete require.cache[require.resolve('../middleware/auth')];
  }

  // After the first test ran and cleaned up, env should match what it was before all tests.
  // If the first test leaked, process.env.JWT_SECRET would still be 'test-secret'.
  assert.notEqual(process.env.JWT_SECRET, 'test-secret',
    'First test leaked JWT_SECRET into process.env');
});

test('verifyRefreshToken restricts accepted JWT algorithms to HS256', () => {
  const originalRefreshSecret = process.env.REFRESH_SECRET;
  process.env.REFRESH_SECRET = 'test-refresh-secret';

  const originalLoad = Module._load;
  let capturedOptions;

  delete require.cache[require.resolve('../middleware/auth')];

  Module._load = (request, parent, isMain) => {
    if (request === 'jsonwebtoken') {
      return {
        sign: () => 'signed-refresh-token',
        verify: (_token, _secret, options) => {
          capturedOptions = options;
          return { id: 'user-1', purpose: 'refresh' };
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const { verifyRefreshToken } = require('../middleware/auth');
    const decoded = verifyRefreshToken('signed-refresh-token');

    assert.deepEqual(decoded, { id: 'user-1', purpose: 'refresh' });
    assert.deepEqual(capturedOptions, { algorithms: ['HS256'] });
  } finally {
    if (originalRefreshSecret === undefined) {
      delete process.env.REFRESH_SECRET;
    } else {
      process.env.REFRESH_SECRET = originalRefreshSecret;
    }
    Module._load = originalLoad;
    delete require.cache[require.resolve('../middleware/auth')];
  }
});

test('verifyRefreshToken rejects non-string inputs to prevent NoSQL query object injection', () => {
  const { verifyRefreshToken } = require('../middleware/auth');
  
  assert.equal(verifyRefreshToken(null), null);
  assert.equal(verifyRefreshToken(undefined), null);
  assert.equal(verifyRefreshToken({ token: 'xyz' }), null);
  assert.equal(verifyRefreshToken(12345), null);
});

test('verifyRefreshToken rejects access tokens due to purpose claim mismatch (domain separation)', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalRefreshSecret = process.env.REFRESH_SECRET;
  process.env.JWT_SECRET = 'shared-secret';
  process.env.REFRESH_SECRET = 'shared-secret'; // Identical secrets to test payload vulnerability

  delete require.cache[require.resolve('../middleware/auth')];

  try {
    const { generateToken, verifyRefreshToken } = require('../middleware/auth');

    // Generate a valid access token signed with the shared secret
    const fakeUser = { _id: { toString: () => 'user-123' }, username: 'bob', role: 'member' };
    const accessToken = generateToken(fakeUser);

    // Attempt to verify the access token using verifyRefreshToken
    const decoded = verifyRefreshToken(accessToken);

    // Should return null due to purpose claim mismatch, even though keys are identical
    assert.equal(decoded, null, 'Access token should not be accepted as a refresh token');
  } finally {
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;

    if (originalRefreshSecret === undefined) delete process.env.REFRESH_SECRET;
    else process.env.REFRESH_SECRET = originalRefreshSecret;

    delete require.cache[require.resolve('../middleware/auth')];
  }
});

test('verifyToken rejects refresh tokens due to purpose claim mismatch', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalRefreshSecret = process.env.REFRESH_SECRET;
  process.env.JWT_SECRET = 'shared-secret';
  process.env.REFRESH_SECRET = 'shared-secret';

  delete require.cache[require.resolve('../middleware/auth')];

  try {
    const { generateRefreshToken, verifyToken } = require('../middleware/auth');

    const fakeUser = { _id: { toString: () => 'user-123' }, username: 'bob', role: 'member' };
    const refreshToken = generateRefreshToken(fakeUser);

    const decoded = verifyToken(refreshToken);

    assert.equal(decoded, null, 'Refresh token should not be accepted as an access token');
  } finally {
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;

    if (originalRefreshSecret === undefined) delete process.env.REFRESH_SECRET;
    else process.env.REFRESH_SECRET = originalRefreshSecret;

    delete require.cache[require.resolve('../middleware/auth')];
  }
});

test('middleware warns in development environment when JWT_SECRET and REFRESH_SECRET are identical', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalRefreshSecret = process.env.REFRESH_SECRET;
  process.env.JWT_SECRET = 'unsafe-shared-secret';
  process.env.REFRESH_SECRET = 'unsafe-shared-secret';

  let warnCalled = false;
  const originalWarn = console.warn;
  console.warn = (msg) => {
    if (msg.includes('identical')) {
      warnCalled = true;
    }
  };

  delete require.cache[require.resolve('../middleware/auth')];

  try {
    require('../middleware/auth');
    assert.ok(warnCalled, 'Should warn if JWT_SECRET and REFRESH_SECRET are identical');
  } finally {
    console.warn = originalWarn;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;

    if (originalRefreshSecret === undefined) delete process.env.REFRESH_SECRET;
    else process.env.REFRESH_SECRET = originalRefreshSecret;

    delete require.cache[require.resolve('../middleware/auth')];
  }
});

test('middleware exits process in production if JWT_SECRET is missing', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalRefreshSecret = process.env.REFRESH_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  delete process.env.JWT_SECRET;
  process.env.REFRESH_SECRET = 'valid-refresh-secret';
  process.env.NODE_ENV = 'production';

  let exitCode = null;
  const originalExit = process.exit;
  process.exit = (code) => {
    exitCode = code;
  };

  delete require.cache[require.resolve('../middleware/auth')];

  try {
    require('../middleware/auth');
    assert.equal(exitCode, 1, 'Should call process.exit(1) if JWT_SECRET is missing in production');
  } finally {
    process.exit = originalExit;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
    if (originalRefreshSecret === undefined) delete process.env.REFRESH_SECRET;
    else process.env.REFRESH_SECRET = originalRefreshSecret;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    delete require.cache[require.resolve('../middleware/auth')];
  }
});

test('middleware exits process in production if REFRESH_SECRET is missing', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalRefreshSecret = process.env.REFRESH_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  process.env.JWT_SECRET = 'valid-jwt-secret';
  delete process.env.REFRESH_SECRET;
  process.env.NODE_ENV = 'production';

  let exitCode = null;
  const originalExit = process.exit;
  process.exit = (code) => {
    exitCode = code;
  };

  delete require.cache[require.resolve('../middleware/auth')];

  try {
    require('../middleware/auth');
    assert.equal(exitCode, 1, 'Should call process.exit(1) if REFRESH_SECRET is missing in production');
  } finally {
    process.exit = originalExit;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
    if (originalRefreshSecret === undefined) delete process.env.REFRESH_SECRET;
    else process.env.REFRESH_SECRET = originalRefreshSecret;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    delete require.cache[require.resolve('../middleware/auth')];
  }
});
