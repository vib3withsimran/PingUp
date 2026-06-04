import { useState, useRef, useCallback, useEffect } from 'react';

export default function MessageInput({
  onSend, onTypingStart, onTypingStop,
  roomName, roomSettings, currentUser,
}) {
  const [text, setText] = useState('');
  const [imagePreview, setImagePreview] = useState(null);
  const [imageFile, setImageFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  
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
    return `Message #${roomName}`;
  };

  // Only focus if not disabled and not already focused (improves accessibility)
  useEffect(() => {
    if (!isDisabled && document.activeElement !== inputRef.current) {
      inputRef.current?.focus();
    }
  }, [roomName, isDisabled]);

  const handleSend = async () => {
    let imageUrl = null;
    
    // Handle Image Upload First
    if (imageFile) {
      setUploading(true);
      const formData = new FormData();
      formData.append('image', imageFile);
      try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok || !data?.imageUrl) {
          throw new Error('Upload failed');
        }
        imageUrl = data.imageUrl;
      } catch (err) {
        alert('Image upload failed');
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    if (!text.trim() && !imageUrl) return;
    
    // Send the message
    onSend(text.trim(), imageUrl);
    
    // Reset inputs and state
    setText('');
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
  };

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (uploading || (!text.trim() && !imageFile) || isDisabled) return;
      handleSend();
    }
  }, [text, isDisabled, imageFile, uploading]);

  const handleChange = useCallback((e) => {
    setText(e.target.value);
    if (!typingRef.current) {
      typingRef.current = true;
      onTypingStart();
    }
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      typingRef.current = false;
      onTypingStop();
    }, 1500);
  }, [onTypingStart, onTypingStop]);

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const removeImage = () => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className={`msg-input-wrap ${isDisabled ? 'msg-input-disabled' : ''}`}>
      {imagePreview && (
        <div style={{ padding: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <img src={imagePreview} alt="preview" style={{ maxHeight: '80px', borderRadius: '8px' }} />
          <button onClick={removeImage} style={{ cursor: 'pointer', background: 'none', border: 'none', fontSize: '16px' }}>✕</button>
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
      />
      
      <input
        type="file"
        accept="image/*"
        ref={fileInputRef}
        onChange={handleImageChange}
        style={{ display: 'none' }}
        disabled={isDisabled}
      />
      
      <button
        className="msg-toolbar-btn"
        onClick={() => fileInputRef.current?.click()}
        disabled={isDisabled}
        title="Attach image"
        style={{ fontSize: '18px', padding: '0 8px', background: 'none', border: 'none', cursor: 'pointer' }}
      >
        📎
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