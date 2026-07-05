import { io } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';

const configuredSocketUrl = import.meta.env.VITE_SOCKET_URL?.trim();
const isLocalHost = typeof window !== 'undefined'
  && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
const SOCKET_URL = configuredSocketUrl || (isLocalHost ? 'http://localhost:3001' : null);

let socket = null;
let queue = [];

export function getSocket(token) {
  if (!SOCKET_URL) {
    throw new Error('VITE_SOCKET_URL is required outside localhost.');
  }

  if (!socket) {
    socket = io(SOCKET_URL, {
      auth: { token },
      autoConnect: false,
      transports: ['websocket', 'polling'],  // ← important for Render
    });

    socket.on('connect', () => {
      const proc = [...queue];
      queue = [];
      proc.forEach(item => {
        emitWithRetry(item.event, item.payload, item.cb, item.att);
      })
    })
  }

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1000;
const ACK_TIMEOUT_MS = 5000;

export function emitWithRetry(event, payload, cb, att = 0) {
  if (!socket || !socket.connected) {
    console.warn(`Socket disconnected. Queueing event: ${event}`);
    queue.push({ event, payload, cb, att });

    return;
  }

  socket.timeout(ACK_TIMEOUT_MS).emit(event, payload, (err, res) => {
    if (err) {
      console.error(`Error emitting ${event}:`, err);
      if (att < MAX_RETRIES) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, att);
        console.log(`Retrying ${event} in ${delay}ms... (Attempt ${att + 1})`);

        setTimeout(() => {
          emitWithRetry(event, payload, cb, att + 1);
        }, delay);
      } else {
        console.error(`Max retries reached for ${event}. Marking as failed.`);
        if (cb) cb({ error: 'Max retries reached', status: 'failed' });
      }
    } else if (cb) cb(res);

  })
}

export function generateClientId() {
  return uuidv4();
}
