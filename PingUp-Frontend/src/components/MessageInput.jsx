import { useState, useRef, useCallback, useEffect } from 'react';
import '../styles/MessageInput.css';
import { getApiUrl } from '../api';
import { useDraftMessage } from '../hooks/useDraftMessage';

const ALLOWED_FILE_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];


export default function MessageInput({
  onSend,
  onTypingStart,
  onTypingStop,
  roomName,
  roomSettings,
  currentUser,
  channelId,
  token,
}) {
  const { text, setText, clearDraft } = useDraftMessage('channel', channelId);
  const [imagePreview, setImagePreview] = useState(null);
  const [imageFile, setImageFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [imageError, setImageError] = useState(null);

  
  const typingRef = useRef(false);
  const typingTimer = useRef(null);
  const fileInputRef = useRef(null);
  const inputRef = useRef(null);

  const isOwner    = currentUser?.role === 'owner';
  const isLocked   = roomSettings?.isLocked;
  const isReadOnly = roomSettings?.isReadOnly && !isOwner;
  const isDisabled = isLocked || isReadOnly;

  const getPlaceholder = () => {
    if (isLocked)   return '🔒 This channel is locked';
    if (isReadOnly) return '🚫 This channel is read-only';
    return `Message #${roomName} (Markdown supported)`;
  };

  // Only focus if not disabled and not already focused (improves accessibility)
  useEffect(() => {
    if (!isDisabled && document.activeElement !== inputRef.current) {
      inputRef.current?.focus();
    }
  }, [roomName, isDisabled]);

  const handleSend = useCallback(async () => {
    let imageUrl = null;
    
    // Handle Image Upload First
    if (imageFile) {
      setUploading(true);
      const formData = new FormData();
      formData.append('image', imageFile);
      try {
        const res = await fetch(getApiUrl('/api/upload'), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: formData,
        });
        const data = await res.json();
        if (!res.ok || !data?.imageUrl) {
          throw new Error('Upload failed');
        }
        imageUrl = data.imageUrl;
      } catch (err) {
        console.error(err);
        alert('Image upload failed');
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    if (!text.trim() && !imageUrl) return;
    
    // Send the message
    onSend(text.trim(), imageUrl);
    
    // Clear draft and reset inputs
    clearDraft();
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    
    // Clear typing indicator
    if (typingRef.current) {
      onTypingStop();
      typingRef.current = false;
    }

    // Restore focus after sending (auto-focus feature)
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [text, imageFile, onSend, onTypingStop, clearDraft, token]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (uploading || (!text.trim() && !imageFile) || isDisabled) return;
      handleSend();
    }
  }, [text, isDisabled, imageFile, uploading, handleSend]);

  const handleChange = useCallback((e) => {
    const newText = e.target.value;
    setText(newText);

    if (!typingRef.current) {
      typingRef.current = true;
      onTypingStart();
    }

    clearTimeout(typingTimer.current);

    typingTimer.current = setTimeout(() => {
      typingRef.current = false;
      onTypingStop();
    }, 1500);
  }, [setText, onTypingStart, onTypingStop]);

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!ALLOWED_FILE_TYPES.includes(file.type)) {
      setImageError('Only images and documents (PDF, DOC, DOCX) are allowed.');
      e.target.value = '';
      return;
    }
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageError(null);
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const removeImage = () => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(null);
    setImagePreview(null);
    setImageError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className={`msg-input-wrap ${isDisabled ? 'msg-input-disabled' : ''}`}>
     {imageError && (
        <p className="image-error-text">{imageError}</p>
      )}

      {imagePreview && (
        <div style={{ padding: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          {imageFile?.type?.startsWith('image/') ? (
            <img src={imagePreview} alt="preview" style={{ maxHeight: '80px', borderRadius: '8px' }} />
          ) : (
            <div style={{ padding: '8px', background: '#f5f5f5', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '8px', color: '#333' }}>
              <span style={{ fontSize: '24px' }}>📄</span>
              <span style={{ fontSize: '14px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {imageFile?.name}
              </span>
            </div>
          )}
          <button onClick={removeImage} style={{ cursor: 'pointer', background: 'none', border: 'none', fontSize: '16px', color: '#666' }}>✕</button>
        </div>
      )}
      
      <textarea
        ref={inputRef}
        className="msg-input"
        placeholder={getPlaceholder()}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={isDisabled}
        rows={1}
        maxLength={2000}
      />
      
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ref={fileInputRef}
        onChange={handleImageChange}
        style={{ display: 'none' }}
        disabled={isDisabled}
      />
      
      <button
        className="msg-toolbar-btn"
        onClick={() => fileInputRef.current?.click()}
        disabled={isDisabled}
        title="Upload File"
        style={{ fontSize: '14px', padding: '0 8px', background: 'none', border: 'none', cursor: 'pointer', color: '#666' }}
      >
        Upload File
      </button>
      
      <button
        className="msg-send-btn"
        disabled={(!text.trim() && !imageFile) || isDisabled || uploading}
        onClick={handleSend}
      >
        {uploading ? '...' : '➤'}
      </button>
    </div>
  );
}