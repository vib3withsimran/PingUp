const { hasPermission, ROLES } = require('../data/store');

const jwt = require('jsonwebtoken');
const User = require('../models/User');

const allowDevFallback = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.trim().length === 0) {
  if (!allowDevFallback) {
    console.error('FATAL: JWT_SECRET environment variable is required.');
    process.exit(1);
  }
  console.warn('WARNING: JWT_SECRET is not defined. Falling back to default development secret.');
}

const JWT_SECRET = (jwtSecret && jwtSecret.trim()) || 'internal_network_secret_2024';

const refreshSecretEnv = process.env.REFRESH_SECRET;
if (!refreshSecretEnv || refreshSecretEnv.trim().length === 0) {
  if (!allowDevFallback) {
    console.error('FATAL: REFRESH_SECRET environment variable is required.');
    process.exit(1);
  }
  console.warn('WARNING: REFRESH_SECRET is not defined. Falling back to default development secret.');
}

const REFRESH_SECRET = (refreshSecretEnv && refreshSecretEnv.trim()) || 'internal_network_refresh_secret_2024';

// Cryptographic best practice: Enforce key separation. If access and refresh tokens share the same secret,
// an access token could potentially be repurposed as a refresh token (token type confusion).
if (JWT_SECRET === REFRESH_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET and REFRESH_SECRET must not be identical in production.');
    process.exit(1);
  }
  console.warn('WARNING: JWT_SECRET and REFRESH_SECRET are identical. This is unsafe for production.');
}

function generateToken(user) {
  return jwt.sign(
    { id: user._id.toString(), username: user.username, role: user.role, purpose: 'access' },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

/**
 * Generates a refresh token with a strict domain separation claim ('purpose: refresh').
 */
function generateRefreshToken(user) {
  return jwt.sign(
    { id: user._id.toString(), purpose: 'refresh' },
    REFRESH_SECRET,
    { expiresIn: '7d' }
  );
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (!decoded || decoded.purpose !== 'access') {
      return null;
    }
    return decoded;
  }
  catch { return null; }
}

/**
 * Verifies and decodes a refresh token.
 * 
 * Non-obvious decisions & security controls:
 * 1. Strict Input Validation: Rejects non-string inputs to mitigate NoSQL injection in database lookups.
 * 2. Algorithm Restricting: Limits algorithms to ['HS256'] to prevent algorithm confusion attacks (e.g. alg='none').
 * 3. Domain Separation Claim: Validates the payload includes a 'purpose' field set to 'refresh' to prevent
 *    cross-purpose token abuse (e.g. submitting an access token to the refresh route) in misconfigured key environments.
 */
function verifyRefreshToken(token) {
  if (typeof token !== 'string') {
    return null;
  }
  try {
    const decoded = jwt.verify(token, REFRESH_SECRET, { algorithms: ['HS256'] });
    if (!decoded || decoded.purpose !== 'refresh') {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

const requireRole = (requiredRole) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ message: 'Unauthorized: No user role found' });
    }

    if (!hasPermission(req.user.role, requiredRole)) {
      return res.status(403).json({ message: 'Forbidden: Insufficient permissions' });
    }

    next();
  };
}

/**
 * Express middleware to enforce authentication on REST API endpoints.
 * Extracts the JWT, validates it, and mounts the payload to req.user.
 */
const requireAuth = (req, res, next) => {
  const authHeaderVal = req.headers.authorization;
  if (!authHeaderVal || !authHeaderVal.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  const token = authHeaderVal.slice('Bearer '.length).trim();
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
  req.user = decoded;
  next();
};

async function socketAuthMiddleware(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('AUTH_REQUIRED'));
  const decoded = verifyToken(token);
  if (!decoded) return next(new Error('INVALID_TOKEN'));
  const user = await User.findById(decoded.id);
  if (!user) return next(new Error('USER_NOT_FOUND'));
  socket.user = { id: user._id.toString(), username: user.username, role: user.role };
  next();
}

module.exports = {
  requireRole,
  ROLES,
  generateToken,
  generateRefreshToken,
  verifyToken,
  verifyRefreshToken,
  socketAuthMiddleware,
  requireAuth
};
