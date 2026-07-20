import { useState, useRef, useEffect } from 'react';
import AudioPlayer from './AudioPlayer';

export default function VoiceRecorder({ onAudioRecorded, onCancel, disabled }) {
  const [recording, setRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [permissionError, setPermissionError] = useState(null);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerRef = useRef(null);

  const startRecording = async () => {
    setPermissionError(null);
    setAudioBlob(null);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    audioChunksRef.current = [];
    setRecordingTime(0);

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setPermissionError('Audio recording is not supported in this browser.');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const mimeType = mediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        const url = URL.createObjectURL(blob);
        setAudioBlob(blob);
        setAudioUrl(url);

        // Stop all audio tracks to release microphone lock
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start(100);
      setRecording(true);

      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (err) {
      console.error('Microphone access error:', err);
      setPermissionError('Microphone access denied or unavailable.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && recording) {
      mediaRecorderRef.current.stop();
      setRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current && recording) {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(null);
    setAudioUrl(null);
    if (onCancel) onCancel();
  };

  const handleSendRecorded = () => {
    if (!audioBlob) return;
    const ext = audioBlob.type.includes('ogg') ? 'ogg' : (audioBlob.type.includes('mp4') || audioBlob.type.includes('m4a') ? 'm4a' : 'webm');
    const audioFile = new File([audioBlob], `voice-note-${Date.now()}.${ext}`, { type: audioBlob.type });
    onAudioRecorded(audioFile);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(null);
    setAudioUrl(null);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const formatTime = (timeInSeconds) => {
    const minutes = Math.floor(timeInSeconds / 60);
    const seconds = timeInSeconds % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  };

  return (
    <div className="voice-recorder-bar" style={{
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '6px 12px',
      background: 'rgba(0, 0, 0, 0.2)',
      borderRadius: '8px',
      margin: '4px 0'
    }}>
      {permissionError && (
        <span style={{ color: '#ed4245', fontSize: '13px', flex: 1 }}>
          ⚠️ {permissionError}
        </span>
      )}

      {!recording && !audioUrl && !permissionError && (
        <button
          type="button"
          onClick={startRecording}
          disabled={disabled}
          title="Record Voice Note"
          aria-label="Start recording voice note"
          style={{
            background: 'none',
            border: 'none',
            fontSize: '18px',
            cursor: 'pointer',
            padding: '4px 8px',
            color: '#fff'
          }}
        >
          🎤
        </button>
      )}

      {recording && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1 }}>
          <span style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: '#ed4245',
            animation: 'pulse 1s infinite'
          }} />
          <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#fff' }}>
            Recording... {formatTime(recordingTime)}
          </span>

          <button
            type="button"
            onClick={stopRecording}
            title="Stop recording"
            aria-label="Stop recording"
            style={{
              padding: '4px 10px',
              borderRadius: '4px',
              border: 'none',
              background: '#ed4245',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            ⏹ Stop
          </button>

          <button
            type="button"
            onClick={cancelRecording}
            title="Cancel recording"
            aria-label="Cancel recording"
            style={{
              background: 'none',
              border: 'none',
              fontSize: '16px',
              cursor: 'pointer',
              color: '#888'
            }}
          >
            ✕
          </button>
        </div>
      )}

      {!recording && audioUrl && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1 }}>
          <AudioPlayer src={audioUrl} title="Voice preview" />

          <button
            type="button"
            onClick={cancelRecording}
            title="Discard voice note"
            aria-label="Discard voice note"
            style={{
              background: 'none',
              border: 'none',
              fontSize: '18px',
              cursor: 'pointer',
              color: '#ed4245'
            }}
          >
            🗑️
          </button>

          <button
            type="button"
            onClick={handleSendRecorded}
            title="Send Voice Note"
            aria-label="Send Voice Note"
            style={{
              padding: '6px 14px',
              borderRadius: '16px',
              border: 'none',
              background: 'var(--accent, #5865f2)',
              color: '#fff',
              fontWeight: 'bold',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            Send Voice Note ➤
          </button>
        </div>
      )}
    </div>
  );
}
