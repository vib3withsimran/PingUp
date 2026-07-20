import { useState, useEffect, useRef, } from 'react';
import { apiFetch } from '../api';
import { useDraftMessage } from '../hooks/useDraftMessage';
import MarkdownMessage from './MarkdownMessage';
import SearchPanel from './SearchPanel';

// Generate a temporary client-side ID for optimistic message rendering
function generateClientId() {
  return `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Emit a socket event and invoke callback with the server's acknowledgement.
// Falls back to a "sent" response after a short delay if the server doesn't ack.
function emitWithRetry(socket, event, data, callback) {
  let settled = false;
  const settle = (res) => {
    if (settled) return;
    settled = true;
    callback?.(res);
  };
  socket.emit(event, data, (res) => settle(res || {}));
  // If no ack within 5 s, treat as sent (server may not support acks)
  setTimeout(() => settle({}), 5000);
}

export default function DMChat({ currentUser, otherUser, token, socket, onClose }) {
  const [messages, setMessages]       = useState([]);
  const [typing, setTyping]           = useState(false);
  const [isTyping, setIsTyping]       = useState(false);
  const [showSearch, setShowSearch]   = useState(false);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);

  const otherUserId = otherUser?.id;
  const currentUserId = currentUser?.id;
  const dmId = currentUser && otherUser ? [currentUser.id, otherUser.id].sort().join('_') : null;

  const { text, setText, clearDraft } = useDraftMessage('dm', dmId);

  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const typingTimeout = useRef(null);

  // Auto-focus input when opening DM
  useEffect(() => {
    inputRef.current?.focus();
  }, [otherUser?.id]);

  // Load history + join DM room
  useEffect(() => {
    if (!currentUserId || !otherUserId) return;
    const conversationId = [currentUserId, otherUserId].sort().join('_');
    const controller = new AbortController();

    apiFetch(`/api/dm/${otherUserId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    })
      .then(r => r.json())
      .then(data => setMessages(Array.isArray(data) ? data : []))
      .catch(err => {
        if (err.name !== 'AbortError') console.error('Failed to load DM history:', err);
      });

    socket.emit('dm:join', { otherUserId });

    const onMessage = (msg) => {
      if (msg.conversationId !== conversationId) return;
      setMessages(prev => {
        const existingMsg = prev.find(m => m.id === msg.id || (msg.clientId && m.id === msg.clientId));
        if (existingMsg) {
          return prev.map(m => m.id === existingMsg.id ? { ...m, ...msg, id: msg.id, status: 'sent' } : m);
        }
        return [...prev, msg];
      });
    };

    const onTyping = ({ username, typing }) => {
      if (username === otherUser?.username) {
        setIsTyping(typing);
      }
    };

    socket.on('dm:message', onMessage);
    socket.on('dm:typing', onTyping);

    return () => {
      controller.abort();
      socket.off('dm:message', onMessage);
      socket.off('dm:typing', onTyping);
      socket.emit('dm:leave', { otherUserId });
    };
  }, [currentUserId, otherUserId, token, socket, otherUser?.username]);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  function handleSend(e) {
    e?.preventDefault();
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
      status: 'sending'
    };

    setMessages(prev => [...prev, optMsg]);
    clearDraft();
    
    inputRef.current?.focus();

    emitWithRetry(socket, 'dm:send', {
      toUserId: otherUser.id,
      text: trimmed,
      clientId
    }, (res) => {
      if (res.error) {
        setMessages(prev => prev.map(m =>
          m.id == clientId ? { ...m, status: 'failed' } : m
        ))
      } else {
        setMessages(prev => prev.map(m =>
          m.id === clientId ? { ...m, id: res.id || m.id, status: 'sent' } : m
        ));
      }
    });
    clearTimeout(typingTimeout.current);
    socket.emit('dm:typing:stop', { toUserId: otherUser.id });
    setTyping(false);
  }

  const handleAudioRecorded = async (audioFile) => {
    const clientId = generateClientId();
    const tempUrl = URL.createObjectURL(audioFile);
    const optMsg = {
      id: clientId,
      senderId: currentUser.id,
      senderUsername: currentUser.username,
      senderRole: currentUser.role,
      text: '',
      audioUrl: tempUrl,
      timestamp: Date.now(),
      status: 'sending'
    };
    setMessages(prev => [...prev, optMsg]);
    setShowVoiceRecorder(false);

    try {
      const formData = new FormData();
      formData.append('file', audioFile);
      const res = await apiFetch('/api/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || (!data?.audioUrl && !data?.fileUrl && !data?.url)) {
        throw new Error('Upload failed');
      }
      const audioUrl = data.audioUrl || data.fileUrl || data.url;

      emitWithRetry(socket, 'dm:send', {
        toUserId: otherUser.id,
        text: '',
        audioUrl,
        clientId
      }, (resp) => {
        if (resp.error) {
          setMessages(prev => prev.map(m => m.id === clientId ? { ...m, status: 'failed' } : m));
        } else {
          setMessages(prev => prev.map(m => m.id === clientId ? { ...m, id: resp.id || m.id, audioUrl, status: 'sent' } : m));
        }
      });
    } catch (err) {
      console.error(err);
      setMessages(prev => prev.map(m => m.id === clientId ? { ...m, status: 'failed' } : m));
    }
  };

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
        <div className="dm-chat-actions">
          <button
            className={`dm-chat-btn ${showSearch ? 'dm-chat-btn-active' : ''}`}
            title="Search messages"
            onClick={() => setShowSearch(!showSearch)}
          >
            🔍
          </button>
          <button className="dm-chat-close" onClick={onClose} title="Close DM">✕</button>
        </div>
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
                  {msg.text && <MarkdownMessage content={msg.text} />}
                  {msg.audioUrl && (
                    <AudioPlayer src={msg.audioUrl} title={`Voice note from ${msg.senderUsername || 'user'}`} />
                  )}
                  {msg.imageUrl && (
                    <img
                      src={msg.imageUrl}
                      alt="shared image"
                      style={{ display: 'block', maxWidth: '250px', maxHeight: '250px', marginTop: '6px', borderRadius: '8px' }}
                    />
                  )}
                </div>
                <div className="dm-msg-meta">
                  <span className="dm-msg-time">{formatTime(msg.timestamp)}</span>
                  {isMe && (
                    <span className="dm-msg-read" title={msg.status || (msg.read ? 'Read' : 'Delivered')}>
                      {msg.status === 'sending' && '🕒'}
                      {msg.status === 'failed' && '⚠️ Failed'}
                      {msg.status === 'sent' && (msg.read ? '✓✓' : '✓')}
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

      {showVoiceRecorder && (
        <div style={{ padding: '0 12px' }}>
          <VoiceRecorder
            onAudioRecorded={handleAudioRecorded}
            onCancel={() => setShowVoiceRecorder(false)}
          />
        </div>
      )}

      {/* Input */}
      <form className="dm-chat-input-row" onSubmit={handleSend}>
        <input
          ref={inputRef}
          value={text}
          onChange={handleChange}
          placeholder={`Message ${otherUser.username} (Markdown supported)...`}
        />
        <button
          type="button"
          className="dm-mic-btn"
          onClick={() => setShowVoiceRecorder(prev => !prev)}
          title={showVoiceRecorder ? "Close Voice Note recorder" : "Record Voice Note"}
          aria-label="Record Voice Note"
          style={{
            background: 'none',
            border: 'none',
            fontSize: '16px',
            cursor: 'pointer',
            padding: '0 6px',
            color: showVoiceRecorder ? '#ed4245' : '#888'
          }}
        >
          🎤
        </button>
        <button type="submit" disabled={!text.trim()}>➤</button>
      </form>

      {showSearch && dmId && (
        <SearchPanel
          dmId={dmId}
          token={token}
          onClose={() => setShowSearch(false)}
        />
      )}
    </div>
  );
}
