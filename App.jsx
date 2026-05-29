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

async function apiAuth(endpoint, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${SOCKET_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Server is not responding. Try again.');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export default function App() {
  const [phase, setPhase] = useState('auth');
  const [authMode, setAuthMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [typingUsers, setTypingUsers] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [onlineCount, setOnlineCount] = useState(0);
  const [error, setError] = useState(null);

  const socketRef = useRef(null);
  const tokenRef = useRef(null);
  const currentUserRef = useRef('');
  const messagesAreaRef = useRef(null);
  const bottomRef = useRef(null);
  const typingTimerRef = useRef(null);
  const isTypingRef = useRef(false);
  const isAtBottomRef = useRef(true);

  const connectSocket = useCallback((token, user) => {
    if (socketRef.current) {
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();
    }
    tokenRef.current = token;
    currentUserRef.current = user;

    const socket = io(SOCKET_URL, {
      auth: { token },
      autoConnect: false,
      reconnectionAttempts: 5,
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnectionStatus('connected'));
    socket.on('disconnect', () => { setConnectionStatus('disconnected'); setTypingUsers([]); });
    socket.on('connect_error', (err) => {
      if (err.message === 'AUTH_REQUIRED' || err.message === 'AUTH_INVALID') {
        setPhase('auth');
        tokenRef.current = null;
      }
      setConnectionStatus('error');
    });
    socket.on('online', (count) => setOnlineCount(count));
    socket.on('history', (history) => {
      setMessages(history.map((m) => ({ ...m, id: m.id || `hist-${Math.random()}` })));
    });
    socket.on('message', (msg) => setMessages((prev) => [...prev, msg]));
    socket.on('system', (event) => setMessages((prev) => [...prev, event]));
    socket.on('typing', ({ username: u, isTyping }) => {
      setTypingUsers((prev) => isTyping ? (prev.includes(u) ? prev : [...prev, u]) : prev.filter((x) => x !== u));
    });
    socket.on('error', ({ message: msg }) => {
      setError(msg);
      setTimeout(() => setError(null), 3000);
    });

    socket.connect();
    setPhase('chat');
  }, []);

  useEffect(() => {
    return () => {
      clearTimeout(typingTimerRef.current);
      socketRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (isAtBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typingUsers]);

  const handleScroll = useCallback(() => {
    const el = messagesAreaRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  const handleAuth = async () => {
    if (!username.trim() || !password) return;
    setAuthLoading(true);
    setAuthError('');
    try {
      const endpoint = authMode === 'login' ? '/auth/login' : '/auth/register';
      const { token, username: user } = await apiAuth(endpoint, { username: username.trim(), password });
      setPassword('');
      connectSocket(token, user);
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  const emitTyping = useCallback((val) => {
    if (!val.trim()) {
      if (isTypingRef.current) { isTypingRef.current = false; socketRef.current?.emit('typing', false); }
      clearTimeout(typingTimerRef.current);
      return;
    }
    if (!isTypingRef.current) { isTypingRef.current = true; socketRef.current?.emit('typing', true); }
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      isTypingRef.current = false;
      socketRef.current?.emit('typing', false);
    }, 1500);
  }, []);

  const handleTextChange = (e) => { setText(e.target.value); emitTyping(e.target.value); };

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

  const logout = () => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    tokenRef.current = null;
    currentUserRef.current = '';
    setMessages([]);
    setUsername('');
    setPassword('');
    setPhase('auth');
    setConnectionStatus('connecting');
  };

  const formatTime = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  const shouldGroupWithPrev = (msgs, i) => {
    if (i === 0) return false;
    const cur = msgs[i], prev = msgs[i - 1];
    return !cur.type && !prev.type && cur.username === prev.username && cur.timestamp - prev.timestamp < 60_000;
  };

  const charsLeft = MAX_MSG_LENGTH - text.length;

  if (phase === 'auth') {
    return (
      <div className="overlay">
        <div className="join-card">
          <div className="join-logo">
            <span className="logo-dot" /><span className="logo-dot" /><span className="logo-dot" />
          </div>
          <h1 className="join-title">live<span>chat</span></h1>

          <div className="auth-tabs">
            <button className={`auth-tab ${authMode === 'login' ? 'active' : ''}`} onClick={() => { setAuthMode('login'); setAuthError(''); }}>Sign in</button>
            <button className={`auth-tab ${authMode === 'register' ? 'active' : ''}`} onClick={() => { setAuthMode('register'); setAuthError(''); }}>Register</button>
          </div>

          <div className="join-input-col">
            <input
              className="join-input"
              placeholder="Username"
              value={username}
              maxLength={32}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAuth()}
              autoFocus
              disabled={authLoading}
            />
            <input
              className="join-input"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAuth()}
              disabled={authLoading}
            />
          </div>

          {authError && <div className="auth-error">{authError}</div>}

          <button
            className="join-btn-full"
            onClick={handleAuth}
            disabled={!username.trim() || !password || authLoading}
          >
            {authLoading ? '…' : authMode === 'login' ? 'Sign in →' : 'Create account →'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <div className="header-brand"><span className="logo-dot sm" />live<b>chat</b></div>
        <div className="header-right">
          {onlineCount > 0 && <span className="online-badge"><span className="online-dot" />{onlineCount} online</span>}
          <span className="current-user">@{currentUserRef.current}</span>
          <button className="logout-btn" onClick={logout}>Sign out</button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <main className="messages-area" ref={messagesAreaRef} onScroll={handleScroll}>
        {messages.map((m, i) => {
          if (m.type === 'system') return <div key={m.id} className="system-msg">{m.text}</div>;
          const isOwn = m.username === currentUserRef.current;
          const grouped = shouldGroupWithPrev(messages, i);
          const avatarColor = getAvatarColor(m.username || '?');
          const initial = (m.username || '?')[0].toUpperCase();
          return (
            <div key={m.id} className={`msg-row ${isOwn ? 'own' : ''} ${grouped ? 'grouped' : ''}`}>
              {!isOwn && (
                <span className="msg-avatar" style={{ background: avatarColor + '22', color: avatarColor, borderColor: avatarColor + '44', visibility: grouped ? 'hidden' : 'visible' }}>
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
            <div className="typing-bubble"><span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" /></div>
            <span className="typing-label">{typingUsers.join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing</span>
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
          {charsLeft < 100 && <span className={`char-counter ${charsLeft < 20 ? 'danger' : ''}`}>{charsLeft}</span>}
        </div>
        <button className="send-btn" onClick={send} disabled={!text.trim()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </footer>
    </div>
  );
}
