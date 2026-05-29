import { useState } from 'react';
import { getApiUrl } from '../api';

export default function Login({ onLogin, onSwitch }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const res = await fetch(getApiUrl('/api/login'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Login failed.'); return; }
      onLogin(data.user, data.token);
    } catch { setError('Cannot reach server.'); }
    finally { setLoading(false); }
  }

  return (
    <div className="auth-split">

      {/* Left — form panel */}
      <div className="auth-panel">
        <div className="auth-form-wrap">
          <h1 className="auth-title">Welcome back!</h1>
          <p className="auth-subtitle">We're so excited to see you again!</p>

          {error && <div className="auth-error">{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="auth-field">
              <label>
                <span>Email or Username <span className="auth-req">*</span></span>
              </label>
              <input
                type="text"
                value={email}
                onChange={e => setEmail(e.target.value)}
                autoFocus
                required
              />
            </div>

            <div className="auth-field">
              <label>
                <span>Password <span className="auth-req">*</span></span>
                <span className="auth-forgot" onClick={() => { }}>Forgot your password?</span>
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </div>

            <button className="auth-btn" type="submit" disabled={loading}>
              {loading ? 'Logging in…' : 'Login'}
            </button>
          </form>

          <p className="auth-switch">
            Need an account?{' '}
            <span className="auth-link" onClick={onSwitch}>Register an account</span>
          </p>
        </div>
      </div>

      <div className="auth-illustration">

        <div className="forest-bg">
          <div className="forest-mountain mountain-1"></div>
          <div className="forest-mountain mountain-2"></div>
          <div className="forest-mountain mountain-3"></div>

          <div className="forest-ground"></div>
        </div>

        <div className="auth-illus-content">

          <div className="pingup-brand">
            <h1>PingUp</h1>

            <p>
              Real-time community chat built for conversations,
              collaboration, and shared experiences.
            </p>
          </div>

          <div className="pingup-features">

            <div className="feature-card">
              <span>💬</span>

              <div>
                <h3>Real-Time Messaging</h3>

                <p>
                  Instant WebSocket-powered conversations with live typing indicators.
                </p>
              </div>
            </div>

            <div className="feature-card">
              <span>🎵</span>

              <div>
                <h3>Music Lounge</h3>

                <p>
                  Join Stranger Things themed listening rooms with synced playback.
                </p>
              </div>
            </div>

            <div className="feature-card">
              <span>🛡️</span>

              <div>
                <h3>Role-Based Permissions</h3>

                <p>
                  Owners, moderators, and members with secure server-side roles.
                </p>
              </div>
            </div>

            <div className="feature-card">
              <span>📨</span>

              <div>
                <h3>Direct Messages</h3>

                <p>
                  Private conversations with unread badges and real-time updates.
                </p>
              </div>
            </div>

          </div>

        </div>

      </div>

    </div>
  );
}
