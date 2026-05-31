import { useState, useEffect, useRef } from 'react';
import { emitWithRetry, generateClientId } from '../socket';

export default function DMChat({ currentUser, otherUser, token, socket, onClose }) {
  const [messages, setMessages]       = useState([]);
  const [text, setText]               = useState('');
  const [typing, setTyping]           = useState(false);
  const [isTyping, setIsTyping]       = useState(false);
  const bottomRef                     = useRef(null);
  const typingTimeout                 = useRef(null);
  const inputRef                      = useRef(null);

  // Auto-focus input when opening DM (removed unnecessary setTimeout)
  useEffect(() => {
    inputRef.current?.focus();
  }, [otherUser?.id]);

  // Load history + join DM room
  useEffect(() => {
    if (!otherUser || !token) return;

    fetch(`https://pingup-backend-1.onrender.com/api/dm/${otherUser.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => setMessages(Array.isArray(data) ? data : []))
      .catch(() => { });

    socket.emit('dm:join', { otherUserId: otherUser.id });

    const onMessage = (msg) => {
      setMessages(prev => {
        const existingMsg = prev.find(m => m.id === msg.id || (msg.clientId && m.id === msg.clientId));
        if (existingMsg) {
          return prev.map(m => m.id === existingMsg.id ? { ...m, ...msg, id: msg.id, status: 'sent' } : m);
        }
        return [...prev, msg];
      });
    };
    const onTyping = ({ username, typing }) => {
      if (username !== currentUser.username) setIsTyping(typing);
    };
    const onRead = () => {
      setMessages(prev => prev.map(m => ({ ...m, read: true })));
    };

    socket.on('dm:message', onMessage);
    socket.on('dm:typing', onTyping);
    socket.on('dm:read', onRead);

    return () => {
      socket.off('dm:message', onMessage);
      socket.off('dm:typing', onTyping);
      socket.off('dm:read', onRead);
    };
  }, [otherUser?.id, currentUser?.username, socket, token]); // Added missing dependencies

  // Auto scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  function handleSend(e) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    const clientId = generateClientId();

    const optMsg = {
      id: clientId, // temporary ID
      senderId: currentUser.id,
      senderUsername: currentUser.username,
      senderRole: currentUser.role,
      text: trimmed,
      timestamp: Date.now(),
      status: 'sending' // <-- New status field
    };

    setMessages(prev => [...prev, optMsg]);
    setText('');
    
    // Maintain focus after sending (removed unnecessary setTimeout)
    inputRef.current?.focus();

    emitWithRetry('dm:send', {
      toUserId: otherUser.id,
      text: trimmed,
      clientId // <-- Send to backend for idempotency
    }, (res) => {
      if (res.error) {
        setMessages(prev => prev.map(m =>
          m.id == clientId ? { ...m, status: 'failed' } : m
        ))
      } else {
        setMessages(prev => prev.map(m =>
          m.id === clientId ? { ...m, id: res.id, status: 'sent' } : m
        ));
      }
    });
    clearTimeout(typingTimeout.current);
    socket.emit('dm:typing:stop', { toUserId: otherUser.id });
    setTyping(false);
  }

  function handleChange(e) {
    setText(e.target.value);
    if (!typing) {
      setTyping(true);
      socket.emit('dm:typing:start', { toUserId: otherUser.id });
    }
    clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => {
      setTyping(false);
      socket.emit('dm:typing:stop', { toUserId: otherUser.id });
    }, 1200);
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const roleColor = { owner: 'var(--danger)', moderator: 'var(--mod-color)', member: 'var(--accent)' };

  return (
    <div className="dm-chat-panel">

      {/* Header */}
      <div className="dm-chat-header">
        <div className={`dm-chat-avatar avatar-${otherUser.role}`}>
          {otherUser.username[0].toUpperCase()}
          <span className="dm-chat-status-dot"
            style={{ background: otherUser.online ? 'var(--success)' : 'var(--text-muted)' }} />
        </div>
        <div className="dm-chat-header-info">
          <span className="dm-chat-username" style={{ color: roleColor[otherUser.role] }}>
            {otherUser.username}
          </span>
          <span className="dm-chat-role">{otherUser.role}</span>
        </div>
        <span className="dm-chat-online-label">
          {otherUser.online ? '🟢 Online' : '⚫ Offline'}
        </span>
        <button className="dm-chat-close" onClick={onClose}>✕</button>
      </div>

      {/* Messages */}
      <div className="dm-chat-messages">
        {messages.length === 0 && (
          <div className="dm-chat-empty">
            <div className={`dm-big-avatar avatar-${otherUser.role}`}>
              {otherUser.username[0].toUpperCase()}
            </div>
            <p>This is the beginning of your conversation with <strong>{otherUser.username}</strong>.</p>
          </div>
        )}

        {messages.map((msg) => {
          const isMe = msg.senderId === currentUser.id;
          return (
            <div key={msg.id} className={`dm-msg-row ${isMe ? 'dm-msg-mine' : 'dm-msg-theirs'}`}>
              {!isMe && (
                <div className={`dm-msg-avatar avatar-${msg.senderRole}`}>
                  {msg.senderUsername[0].toUpperCase()}
                </div>
              )}
              <div className="dm-msg-bubble-wrap">
                {!isMe && (
                  <span className="dm-msg-name" style={{ color: roleColor[msg.senderRole] }}>
                    {msg.senderUsername}
                  </span>
                )}
                <div className={`dm-msg-bubble ${isMe ? 'bubble-mine' : 'bubble-theirs'}`}>
                  {msg.text}
                </div>
                <div className="dm-msg-meta">
                  <span className="dm-msg-time">{formatTime(msg.timestamp)}</span>
                  {isMe && (
                    <span className="dm-msg-read" title={msg.status || (msg.read ? 'Read' : 'Delivered')}>
                      {msg.status === 'sending' && '🕒'}
                      {msg.status === 'failed' && '⚠️ Failed'}
                      {msg.status === 'sent' && (msg.read ? '✓✓' : '✓')}
                      {/* Fallback for old messages without status */}
                      {!msg.status && (msg.read ? '✓✓' : '✓')}
                    </span>
                  )}
                </div>
              </div>
              {isMe && (
                <div className={`dm-msg-avatar avatar-${currentUser.role}`}>
                  {currentUser.username[0].toUpperCase()}
                </div>
              )}
            </div>
          );
        })}

        {isTyping && (
          <div className="dm-msg-row dm-msg-theirs">
            <div className={`dm-msg-avatar avatar-${otherUser.role}`}>
              {otherUser.username[0].toUpperCase()}
            </div>
            <div className="dm-typing-bubble">
              <span /><span /><span />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form className="dm-chat-input-row" onSubmit={handleSend}>
        <input
          ref={inputRef}
          value={text}
          onChange={handleChange}
          placeholder={`Message ${otherUser.username}…`}
        />
        <button type="submit" disabled={!text.trim()}>➤</button>
      </form>
    </div>
  );
}
