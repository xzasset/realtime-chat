import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import './chat.css';

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || 'http://localhost:4000';
const MAX_MSG_LENGTH = 1000;

function getAvatarColor(username) {
  const colors = ['#5b7cfa', '#a78bfa', '#38bdf8', '#34d399', '#fb923c', '#f472b6', '#facc15'];
  let hash = 0;
  for (let i = 0; i < username.length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export default function App() {
  const [phase, setPhase] = useState('join');
  const [username, setUsername] = useState('');
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [typingUsers, setTypingUsers] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [onlineCount, setOnlineCount] = useState(0);
  const [error, setError] = useState(null);
  const [joining, setJoining] = useState(false);

  const socketRef = useRef(null);
  const messagesAreaRef = useRef(null);
  const bottomRef = useRef(null);
  const typingTimerRef = useRef(null);
  const isTypingRef = useRef(false);
  const isAtBottomRef = useRef(true);

  useEffect(() => {
    const socket = io(SOCKET_URL, { autoConnect: false });
    socketRef.current = socket;

    socket.on('connect', () => setConnectionStatus('connected'));
    socket.on('disconnect', () => {
      setConnectionStatus('disconnected');
      setTypingUsers([]);
    });
    socket.on('connect_error', () => setConnectionStatus('error'));
    socket.on('online', (count) => setOnlineCount(count));

    socket.on('history', (history) => {
      setMessages(history.map((m) => ({
        ...m,
        id: m.id || `hist-${Math.random()}`,
      })));
    });

    socket.on('message', (msg) => {
      setMessages((prev) => [...prev, msg]);
    });

    socket.on('system', (event) => {
      setMessages((prev) => [...prev, event]);
    });

    socket.on('typing', ({ username: user, isTyping }) => {
      setTypingUsers((prev) =>
        isTyping ? (prev.includes(user) ? prev : [...prev, user]) : prev.filter((u) => u !== user)
      );
    });

    socket.on('error', ({ message: msg }) => {
      setError(msg);
      setTimeout(() => setError(null), 3000);
    });

    socket.connect();
    return () => {
      clearTimeout(typingTimerRef.current);
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, typingUsers]);

  const handleScroll = useCallback(() => {
    const el = messagesAreaRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  const handleJoin = () => {
    const name = username.trim();
    if (!name || joining || connectionStatus !== 'connected') return;
    setJoining(true);
    socketRef.current?.emit('join', name);
    setPhase('chat');
  };

  const emitTyping = useCallback((val) => {
    if (!val.trim()) {
      if (isTypingRef.current) {
        isTypingRef.current = false;
        socketRef.current?.emit('typing', false);
      }
      clearTimeout(typingTimerRef.current);
      return;
    }
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      socketRef.current?.emit('typing', true);
    }
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      isTypingRef.current = false;
      socketRef.current?.emit('typing', false);
    }, 1500);
  }, []);

  const handleTextChange = (e) => {
    setText(e.target.value);
    emitTyping(e.target.value);
  };

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    socketRef.current?.emit('message', trimmed);
    setText('');
    clearTimeout(typingTimerRef.current);
    isTypingRef.current = false;
    socketRef.current?.emit('typing', false);
    isAtBottomRef.current = true;
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  };

  const formatTime = (ts) => {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const shouldGroupWithPrev = (messages, index) => {
    if (index === 0) return false;
    const cur = messages[index];
    const prev = messages[index - 1];
    return (
      !cur.type &&
      !prev.type &&
      cur.username === prev.username &&
      cur.timestamp - prev.timestamp < 60_000
    );
  };

  const charsLeft = MAX_MSG_LENGTH - text.length;
  const charsWarning = charsLeft < 100;

  if (phase === 'join') {
    return (
      <div className="overlay">
        <div className="join-card">
          <div className="join-logo">
            <span className="logo-dot" />
            <span className="logo-dot" />
            <span className="logo-dot" />
          </div>
          <h1 className="join-title">live<span>chat</span></h1>
          <p className="join-sub">Enter a name to start chatting</p>
          <div className="join-input-row">
            <input
              className="join-input"
              placeholder="Your name..."
              value={username}
              maxLength={32}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
              autoFocus
              disabled={connectionStatus !== 'connected'}
            />
            <button
              className="join-btn"
              onClick={handleJoin}
              disabled={!username.trim() || connectionStatus !== 'connected'}
            >
              →
            </button>
          </div>
          <div className={`status-pill ${connectionStatus}`}>
            <span className="status-dot" />
            {connectionStatus === 'connected'
              ? 'Server reachable'
              : connectionStatus === 'connecting'
              ? 'Connecting…'
              : 'Cannot reach server'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <div className="header-brand">
          <span className="logo-dot sm" />
          live<b>chat</b>
        </div>
        <div className="header-right">
          {onlineCount > 0 && (
            <span className="online-badge">
              <span className="online-dot" />
              {onlineCount} online
            </span>
          )}
          <div className={`status-pill ${connectionStatus}`}>
            <span className="status-dot" />
            {connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'disconnected' ? 'Disconnected' : 'Error'}
          </div>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <main className="messages-area" ref={messagesAreaRef} onScroll={handleScroll}>
        {messages.map((m, i) => {
          if (m.type === 'system') {
            return <div key={m.id} className="system-msg">{m.text}</div>;
          }
          const isOwn = m.username === username;
          const grouped = shouldGroupWithPrev(messages, i);
          const avatarColor = getAvatarColor(m.username || '?');
          const initial = (m.username || '?')[0].toUpperCase();

          return (
            <div key={m.id} className={`msg-row ${isOwn ? 'own' : ''} ${grouped ? 'grouped' : ''}`}>
              {!isOwn && (
                <span
                  className="msg-avatar"
                  style={{ background: avatarColor + '22', color: avatarColor, borderColor: avatarColor + '44', visibility: grouped ? 'hidden' : 'visible' }}
                >
                  {initial}
                </span>
              )}
              <div className="msg-bubble-wrap">
                {!isOwn && !grouped && <span className="msg-name" style={{ color: avatarColor }}>{m.username}</span>}
                <div className="msg-bubble">
                  <span className="msg-text">{m.text}</span>
                  <span className="msg-time">{formatTime(m.timestamp)}</span>
                </div>
              </div>
            </div>
          );
        })}

        {typingUsers.length > 0 && (
          <div className="typing-row">
            <div className="typing-bubble">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
            <span className="typing-label">
              {typingUsers.join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing
            </span>
          </div>
        )}
        <div ref={bottomRef} />
      </main>

      <footer className="chat-footer">
        <div className="input-wrap">
          <input
            className="msg-input"
            value={text}
            onChange={handleTextChange}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
            placeholder="Type a message…"
            maxLength={MAX_MSG_LENGTH}
          />
          {charsWarning && (
            <span className={`char-counter ${charsLeft < 20 ? 'danger' : ''}`}>{charsLeft}</span>
          )}
        </div>
        <button className="send-btn" onClick={send} disabled={!text.trim()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </footer>
    </div>
  );
}
