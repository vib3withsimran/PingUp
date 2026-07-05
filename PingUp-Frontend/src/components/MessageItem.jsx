import MarkdownMessage from './MarkdownMessage';
import { formatRelativeTime } from '../utils/formatRelativeTime';

export default function MessageItem({
  msg,
  hoveredMsg,
  setHoveredMsg,
  currentUser,
  isMod,
  editingMsgId,
  editText,
  setEditText,
  handleEditSave,
  handleEditCancel,
  handleEditStart,
  onOpenThread,
  handlePin,
  handleReaction,
  handleEditReaction,
  handleDelete,
  setShowEditHistory
}) {
  return (
    <div
      id={`message-${msg.id}`}
      className={`msg-row ${msg.deleted ? 'msg-deleted' : ''} ${msg.pinned && !msg.deleted ? 'msg-is-pinned' : ''}`}
      onMouseEnter={() => setHoveredMsg(msg.id)}
      onMouseLeave={() => setHoveredMsg(null)}
    >
      <div className={`msg-avatar msg-avatar-role-${msg.role}`}>
        {msg.username?.[0]?.toUpperCase()}
      </div>

      <div className="msg-content">
        <div className="msg-header">
          <span className={`msg-username msg-username-${msg.role}`}>
            {msg.username}
          </span>
          <span className={`msg-role-pill msg-role-pill-${msg.role}`}>
            {msg.role}
          </span>
          <span className="msg-time">
            {new Date(msg.timestamp).toLocaleTimeString([], {
              hour: '2-digit', minute: '2-digit',
            })}
          </span>
          {msg.editedAt && (
            <span 
              className="msg-edited-tag"
              onClick={() => msg.editHistory && setShowEditHistory(msg)}
              title={`Click to view edit history (last edited ${new Date(msg.editedAt).toLocaleString()})`}
            >
              ✏️ edited {formatRelativeTime(msg.editedAt)}
            </span>
          )}
          {msg.replyCount > 0 && (
            <span
              className="msg-thread-badge"
              onClick={() => onOpenThread(msg)}
            >
              💬 {msg.replyCount} repl{msg.replyCount > 1 ? 'ies' : 'y'}
            </span>
          )}
          {msg.pinned && !msg.deleted && (
            <span className="msg-pin-tag">📌 pinned</span>
          )}
        </div>

        {editingMsgId === msg.id ? (
          <div className="msg-edit-input-container">
            <textarea
              className="msg-edit-input"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              autoFocus
              maxLength={2000}
            />
            <div className="msg-edit-buttons">
              <button
                className="msg-edit-btn msg-edit-save"
                onClick={() => handleEditSave(msg.id)}
              >
                Save
              </button>
              <button
                className="msg-edit-btn msg-edit-cancel"
                onClick={handleEditCancel}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="msg-text">
            <MarkdownMessage content={msg.text} />
            {msg.imageUrl && (
              <img
                src={msg.imageUrl}
                alt="shared image"
                style={{ display: 'block', maxWidth: '300px', maxHeight: '300px', marginTop: '8px', borderRadius: '8px', cursor: 'pointer' }}
                onClick={() => {
                  if (typeof msg.imageUrl !== 'string') return;
                  if (!msg.imageUrl.startsWith('/uploads/')) return;
                  window.open(msg.imageUrl, '_blank', 'noopener,noreferrer');
                }}
              />
            )}
          </div>
        )}
        {msg.reactions?.length > 0 && (
          <div className="msg-reactions">
            {msg.reactions.map((reaction, idx) => (
              <button
                key={idx}
                className="msg-reaction-chip"
                onClick={() => handleReaction(msg.id, reaction.emoji)}
              >
                <span>{reaction.emoji}</span>
                <span>{reaction.users.length}</span>
              </button>
            ))}
          </div>
        )}
        {msg.editReactions?.length > 0 && (
          <div className="msg-reactions msg-edit-reactions">
            {msg.editReactions.map((reaction, idx) => (
              <button
                key={idx}
                className="msg-reaction-chip msg-edit-reaction-chip"
                onClick={() => handleEditReaction(msg.id, reaction.emoji)}
                title="Reaction to edit"
              >
                ✏️ <span>{reaction.emoji}</span>
                <span>{reaction.users.length}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!msg.deleted && hoveredMsg === msg.id && (
        <div className="msg-toolbar">
          {(msg.userId === currentUser?.id || isMod) && editingMsgId !== msg.id && (
            <button
              className="msg-toolbar-btn"
              title="Edit message"
              onClick={() => handleEditStart(msg)}
            >✏️</button>
          )}
          <button
            className="msg-toolbar-btn"
            title="Reply to message"
            onClick={() => onOpenThread(msg)}
          >
            ↩️
          </button>
          {isMod && (
            <button
              className="msg-toolbar-btn"
              title={msg.pinned ? 'Unpin' : 'Pin message'}
              onClick={() => handlePin(msg.id)}
            >📌</button>
          )}

          <button
            className="msg-toolbar-btn"
            title="React"
            onClick={() => handleReaction(msg.id, '👍')}
          >👍</button>
          <button
            className="msg-toolbar-btn"
            title="React"
            onClick={() => handleReaction(msg.id, '😂')}
          >😂</button>
          <button
            className="msg-toolbar-btn"
            title="React"
            onClick={() => handleReaction(msg.id, '🔥')}
          >🔥</button>

          {msg.editedAt && (
            <button
              className="msg-toolbar-btn msg-toolbar-btn-edit-react"
              title="React to Edit"
              onClick={() => handleEditReaction(msg.id, '👍')}
            >✏️👍</button>
          )}

          {isMod && (
            <button
              className="msg-toolbar-btn msg-toolbar-btn-delete"
              title="Delete message"
              onClick={() => handleDelete(msg.id)}
            >🗑️</button>
          )}
        </div>
      )}
    </div>
  );
}
