import { useState } from 'react';

// Extracting shared styles to keep code clean and DRY
const clearButtonBaseStyle = {
  background: 'rgba(255,255,255,0.1)',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--text-muted)',
  fontSize: '12px',
  width: '22px',
  height: '22px',
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background-color 0.2s, opacity 0.2s'
};

export default function FriendsPanel({ onlineUsers }) {
  const [tab, setTab] = useState('online');
  const [search, setSearch] = useState('');
  const [addFriendInput, setAddFriendInput] = useState('');

  const tabs = ['online', 'all', 'pending'];

  const filtered = onlineUsers.filter(u =>
    u.username.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="friends-panel">

      {/* ── Header ── */}
      <div className="fp-header">
        <span className="fp-header-icon">👥</span>
        <span className="fp-header-title">Friends</span>

        <div className="fp-tabs">
          {tabs.map(t => (
            <button
              key={t}
              className={`fp-tab ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <button
          className={`fp-add-btn ${tab === 'add_friend' ? 'active' : ''
            }`}
          onClick={() => setTab('add_friend')}
        >
          Add Friend
        </button>
      </div>

      {tab === 'add_friend' ? (
        <div
          className="fp-add-friend-page"
          style={{ padding: '20px' }}
        >
          <h2
            style={{
              marginBottom: '10px',
              color: 'var(--text-primary)',
              fontWeight: 600,
              fontSize: '16px',
              textTransform: 'uppercase'
            }}
          >
            Add Friend
          </h2>

          <p
            style={{
              color: 'var(--text-secondary)',
              marginBottom: '20px',
              fontSize: '14px'
            }}
          >
            You can add friends with their username.
          </p>

          <div
            style={{
              display: 'flex',
              backgroundColor: 'var(--bg-elevated)',
              borderRadius: '8px',
              padding: '8px 12px',
              border: addFriendInput.trim()
                ? '1px solid var(--accent)'
                : '1px solid var(--border)',
              alignItems: 'center',
              transition: 'border-color 0.2s'
            }}
          >
            <input
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                color: 'var(--text-primary)',
                fontSize: '16px',
                outline: 'none'
              }}
              placeholder="Enter username"
              value={addFriendInput}
              onChange={(e) =>
                setAddFriendInput(e.target.value)
              }
            />

            {/* Clear Button for Add Friend Input */}
            {addFriendInput.trim().length > 0 && (
              <button
                type="button"
                aria-label="Clear username input"
                onClick={() => setAddFriendInput('')}
                style={{
                  ...clearButtonBaseStyle,
                  marginLeft: '8px'
                }}
                onMouseEnter={(e) => e.currentTarget.style.opacity = '0.8'}
                onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
              >
                ✕
              </button>
            )}

            <button
              style={{
                backgroundColor:
                  addFriendInput.trim().length > 0
                    ? 'var(--accent)'
                    : 'var(--accent-muted)',
                color: '#fff',
                border: 'none',
                padding: '8px 16px',
                borderRadius: '6px',
                cursor:
                  addFriendInput.trim().length > 0
                    ? 'pointer'
                    : 'not-allowed',
                fontWeight: 600,
                transition:
                  'background-color 0.2s, color 0.2s',
                marginLeft: '12px'
              }}
              disabled={
                addFriendInput.trim().length === 0
              }
              onClick={() => {
                console.log(
                  `Friend request initiated for ${addFriendInput.trim()}`
                );

                setAddFriendInput('');
              }}
            >
              Send Friend Request
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* ── Search ── */}
          <div className="fp-search-wrap" style={{ position: 'relative' }}>
            <input
              className="fp-search"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ paddingRight: '35px' }}
            />

            {/* Clear Button for Main Search */}
            {search.trim().length > 0 && (
              <button
                type="button"
                aria-label="Clear search input"
                onClick={() => setSearch('')}
                style={{
                  ...clearButtonBaseStyle,
                  position: 'absolute',
                  right: '10px',
                  top: '50%',
                  transform: 'translateY(-50%)'
                }}
                onMouseEnter={(e) => e.currentTarget.style.opacity = '0.8'}
                onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
              >
                ✕
              </button>
            )}
          </div>

          {/* ── List ── */}
          <div className="fp-list-header">
            {tab.charAt(0).toUpperCase() + tab.slice(1)} —{' '}
            {filtered.length}
          </div>

          <div className="fp-list">
            {filtered.length === 0 && (
              <div className="fp-empty">
                No users found.
              </div>
            )}

            {filtered.map(u => (
              <div
                key={u.id}
                className="fp-user-row"
              >
                <div
                  className={`fp-avatar avatar-${u.role}`}
                >
                  {u.username[0].toUpperCase()}

                  <span
                    className="fp-dot"
                    style={{ background: '#23a55a' }}
                  />
                </div>

                <div className="fp-user-info">
                  <span
                    className={`fp-username role-${u.role}`}
                  >
                    {u.username}
                  </span>

                  <span className="fp-userstatus">
                    🟢 Online
                  </span>
                </div>

                <div className="fp-user-actions">
                  <button
                    className="fp-action-btn"
                    title="Message"
                  >
                    💬
                  </button>

                  <button
                    className="fp-action-btn"
                    title="More"
                  >
                    ⋯
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
