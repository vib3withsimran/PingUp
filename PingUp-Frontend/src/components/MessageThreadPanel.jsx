import { formatRelativeTime } from '../utils/formatRelativeTime';

export default function MessageThreadPanel({
  selectedThread,
  onOpenThread,
  threadReplies,
  hoveredReply,
  setHoveredReply,
  editingReplyId,
  setEditingReplyId,
  currentUser,
  isMod,
  editText,
  setEditText,
  handleEditSave,
  handleEditCancel,
  handleDelete,
  handleReaction,
  handleEditReaction,
  threadReplyText,
  setThreadReplyText,
  socket,
  channelId,
  roomName,
}) {
  if (!selectedThread) return null;

  return (
    <div className="msg-thread-panel">
      <div className="msg-thread-header">
        <h3>Thread</h3>
        <button
          className="msg-thread-close"
          onClick={() => onOpenThread(null)}
        >
          ✕
        </button>
      </div>

      <div className="msg-thread-parent">
        <strong>{selectedThread.username}</strong>
        <p>{selectedThread.text}</p>
      </div>

      <div className="msg-thread-replies">
        {threadReplies.map(reply => (
          <div
            key={reply.id}
            className={`msg-thread-reply ${reply.deleted ? 'msg-deleted' : ''}`}
            onMouseEnter={() => setHoveredReply(reply.id)}
            onMouseLeave={() => setHoveredReply(null)}
          >
            <div className="msg-thread-reply-user">
              {reply.username}
              {reply.editedAt && (
                <span className="msg-edited-tag" title={`Edited ${new Date(reply.editedAt).toLocaleString()}`}>
                  ✏️ edited {formatRelativeTime(reply.editedAt)}
                </span>
              )}
            </div>

            {editingReplyId === reply.id ? (
              <div className="msg-edit-input-container">
                <textarea
                  className="msg-edit-input"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  autoFocus
                />
                <div className="msg-edit-buttons">
                  <button
                    className="msg-edit-btn msg-edit-save"
                    onClick={() => {
                      handleEditSave(reply.id);
                      setEditingReplyId(null);
                    }}
                  >Save</button>
                  <button
                    className="msg-edit-btn msg-edit-cancel"
                    onClick={() => {
                      handleEditCancel();
                      setEditingReplyId(null);
                    }}
                  >Cancel</button>
                </div>
              </div>
            ) : (
              <div className="msg-thread-reply-text">
                {reply.deleted ? '[message deleted]' : reply.text}
              </div>
            )}
            
            {reply.reactions?.length > 0 && (
              <div className="msg-reactions">
                {reply.reactions.map((reaction, idx) => (
                  <button
                    key={idx}
                    className="msg-reaction-chip"
                    onClick={() => handleReaction(reply.id, reaction.emoji)}
                  >
                    <span>{reaction.emoji}</span>
                    <span>{reaction.users.length}</span>
                  </button>
                ))}
              </div>
            )}
            {reply.editReactions?.length > 0 && (
              <div className="msg-reactions msg-edit-reactions">
                {reply.editReactions.map((reaction, idx) => (
                  <button
                    key={idx}
                    className="msg-reaction-chip msg-edit-reaction-chip"
                    onClick={() => handleEditReaction(reply.id, reaction.emoji)}
                    title="Reaction to edit"
                  >
                    ✏️ <span>{reaction.emoji}</span>
                    <span>{reaction.users.length}</span>
                  </button>
                ))}
              </div>
            )}

            {!reply.deleted && hoveredReply === reply.id && (
              <div className="msg-toolbar">
                {(reply.userId === currentUser?.id || isMod) && editingReplyId !== reply.id && (
                  <button
                    className="msg-toolbar-btn"
                    title="Edit reply"
                    onClick={() => {
                      setEditingReplyId(reply.id);
                      setEditText(reply.text);
                    }}
                  >✏️</button>
                )}
                
                <button
                  className="msg-toolbar-btn"
                  title="React"
                  onClick={() => handleReaction(reply.id, '👍')}
                >👍</button>

                {reply.editedAt && (
                  <button
                    className="msg-toolbar-btn msg-toolbar-btn-edit-react"
                    title="React to Edit"
                    onClick={() => handleEditReaction(reply.id, '👍')}
                  >✏️👍</button>
                )}

                {isMod && (
                  <button
                    className="msg-toolbar-btn msg-toolbar-btn-delete"
                    title="Delete reply"
                    onClick={() => handleDelete(reply.id)}
                  >🗑️</button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="msg-thread-input-wrap">
        <textarea
          className="msg-thread-input"
          placeholder="Reply to thread..."
          value={threadReplyText}
          onChange={(e) => setThreadReplyText(e.target.value)}
        />
        <button
          className="msg-thread-send-btn"
          onClick={() => {
            if (!threadReplyText.trim()) return;
            socket?.emit('message:send', {
              channelId,
              roomName,
              text: threadReplyText,
              parentMessageId: selectedThread.id,
            });
            setThreadReplyText('');
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
