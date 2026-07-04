import { useState, useEffect, useRef } from 'react';
import PinnedSidebar from './PinnedSidebar';
import EditHistoryModal from './EditHistoryModal';
import MessageItem from './MessageItem';
import MessageThreadPanel from './MessageThreadPanel';
export default function MessageList({
  messages,
  notifications,
  selectedThread,
  threadReplies,
  onOpenThread,
  commandResponses,
  typingUsers,
  currentUser,
  socket,
  channelId,
  roomName,
  roomSettings,
}) {
  const [hoveredMsg, setHoveredMsg] = useState(null);
  const [editingMsgId, setEditingMsgId] = useState(null);
  const [editText, setEditText] = useState('');
  const [showEditHistory, setShowEditHistory] = useState(null);
  const [threadReplyText, setThreadReplyText] = useState('');
  const [hoveredReply, setHoveredReply] = useState(null);
  const [editingReplyId, setEditingReplyId] = useState(null);
  const [showPinnedSidebar, setShowPinnedSidebar] = useState(false);
  const bottomRef = useRef(null);
  const isMod = ['owner', 'moderator'].includes(currentUser?.role);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);


  function handleDelete(msgId) {
    if (!confirm('Delete this message?')) return;
    socket?.emit('message:delete', { channelId, roomName, messageId: msgId });
  }

  function handlePin(msgId) {
    socket?.emit('message:pin', { channelId, roomName, messageId: msgId });
  }

  function handleReaction(msgId, emoji) {
    socket?.emit('message:reaction', {
      messageId: msgId,
      emoji,
    });
  }

  function handleEditReaction(msgId, emoji) {
    socket?.emit('message:edit:reaction', {
      messageId: msgId,
      emoji,
    });
  }

  function handleEditStart(msg) {
    setEditingMsgId(msg.id);
    setEditText(msg.text);
  }

  function handleEditCancel() {
    setEditingMsgId(null);
    setEditText('');
  }

  function handleEditSave(msgId) {
    if (!editText.trim()) {
      alert('Message cannot be empty');
      return;
    }
    socket?.emit('message:edit', {
      channelId,
      roomName,
      messageId: msgId,
      newText: editText,
    });
    setEditingMsgId(null);
    setEditText('');
  }

  const pinnedMessages = messages.filter(m => m.pinned && !m.deleted);

  const mainMessages = messages.filter(
  (msg) => !msg.parentMessageId
);

  return (
    <div className="msg-list">

  <PinnedSidebar
    showPinnedSidebar={showPinnedSidebar}
    setShowPinnedSidebar={setShowPinnedSidebar}
    pinnedMessages={pinnedMessages}
    isMod={isMod}
    handlePin={handlePin}
  />
      {/* ── Edit History Modal ── */}
      <EditHistoryModal
        showEditHistory={showEditHistory}
        setShowEditHistory={setShowEditHistory}
      />
      <div className="msg-pinned-toolbar">
      <button
    className="msg-pinned-toggle-btn"
    onClick={() => setShowPinnedSidebar(v => !v)}
  >
     📌 Pinned ({pinnedMessages.length})
   </button>
</div>
      {/* ── Pinned messages banner ── */}
      {/* {pinnedMessages.length > 0 && (
        <div className="msg-pinned-banner">
          <span className="msg-pinned-label">📌 {pinnedMessages.length} pinned</span>
          <div className="msg-pinned-list">
            {pinnedMessages.map(m => (
              <div key={m.id} className="msg-pinned-item">
                <span className="msg-pinned-author">{m.username}:</span>
                <span className="msg-pinned-text">{m.text}</span>
                {isMod && (
                  <button
                    className="msg-pinned-unpin"
                    onClick={() => handlePin(m.id)}
                    title="Unpin"
                  >✕</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )} */}

      {/* ── Room status badges ── */}
      {(
  roomSettings?.isReadOnly ||
  roomSettings?.isLocked ||
  roomSettings?.isPrivate ||
  roomSettings?.slowModeSeconds > 0
) && (
  <div className="msg-room-status-row">

    {roomSettings.isReadOnly && (
      <span className="msg-room-badge badge-readonly">
        🔇 Read-only
      </span>
    )}

    {roomSettings.isLocked && (
      <span className="msg-room-badge badge-locked">
        🔒 Locked
      </span>
    )}

    {roomSettings.isPrivate && (
      <span className="msg-room-badge badge-private">
        👁️ Private
      </span>
    )}

    {roomSettings?.slowModeSeconds > 0 && (
      <span className="msg-room-badge badge-slowmode">
        🐢 Slow Mode ({roomSettings.slowModeSeconds}s)
      </span>
    )}

  </div>
)}
      {/* ── Notifications ── */}
      {notifications.map((n, i) => (
        <div key={i} className="msg-notification">{n}</div>
      ))}

      {/* ── Messages ── */}
      <div className="msg-messages-wrap">

        {mainMessages.map(msg => (
          <MessageItem
            key={msg.id}
            msg={msg}
            hoveredMsg={hoveredMsg}
            setHoveredMsg={setHoveredMsg}
            currentUser={currentUser}
            isMod={isMod}
            editingMsgId={editingMsgId}
            editText={editText}
            setEditText={setEditText}
            handleEditSave={handleEditSave}
            handleEditCancel={handleEditCancel}
            handleEditStart={handleEditStart}
            onOpenThread={onOpenThread}
            handlePin={handlePin}
            handleReaction={handleReaction}
            handleEditReaction={handleEditReaction}
            handleDelete={handleDelete}
            setShowEditHistory={setShowEditHistory}
          />
        ))}

        {/* ── Command responses ── */}
        {commandResponses.map((r, i) => (
          <div key={i} className={`msg-command-resp msg-command-resp-${r.type}`}>
            <pre className="msg-command-pre">{r.text}</pre>
          </div>
        ))}

        {/* ── Typing indicator ── */}
        {typingUsers.length > 0 && (
          <div className="msg-typing">
            <div className="typing-dots">
              <span /><span /><span />
            </div>
            <span>
              {typingUsers.join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing…
            </span>
          </div>
        )}

        

        <MessageThreadPanel
          selectedThread={selectedThread}
          onOpenThread={onOpenThread}
          threadReplies={threadReplies}
          hoveredReply={hoveredReply}
          setHoveredReply={setHoveredReply}
          editingReplyId={editingReplyId}
          setEditingReplyId={setEditingReplyId}
          currentUser={currentUser}
          isMod={isMod}
          editText={editText}
          setEditText={setEditText}
          handleEditSave={handleEditSave}
          handleEditCancel={handleEditCancel}
          handleDelete={handleDelete}
          handleReaction={handleReaction}
          handleEditReaction={handleEditReaction}
          threadReplyText={threadReplyText}
          setThreadReplyText={setThreadReplyText}
          socket={socket}
          channelId={channelId}
          roomName={roomName}
        />

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
