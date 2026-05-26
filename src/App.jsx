import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const socket = io('http://localhost:4000');

export default function App() {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [username, setUsername] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    socket.on('message', (data) => {
      setMessages((prev) => [...prev, data]);
    });
    return () => socket.off('message');
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = () => {
    if (!text.trim()) return;
    socket.emit('message', { username: username || 'Аноним', text });
    setText('');
  };

  return (
    <div style={{ maxWidth: 600, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <input
        placeholder="Имя"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        style={{ marginBottom: 12, padding: 8, width: '100%' }}
      />
      <div style={{ height: 400, overflowY: 'auto', border: '1px solid #ccc', padding: 12, borderRadius: 8 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <strong>{m.username}:</strong> {m.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Сообщение..."
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={send} style={{ padding: '8px 16px' }}>Отправить</button>
      </div>
    </div>
  );
}
