const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.json());

const db = { users: {} };

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (db.users[username]) return res.status(409).json({ error: 'User exists' });
  db.users[username] = { password, contacts: [], chats: {} };
  res.json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.users[username];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ success: true, username });
});

app.get('/api/contacts/:username', (req, res) => {
  const user = db.users[req.params.username];
  res.json({ contacts: user ? user.contacts : [] });
});

app.post('/api/contacts/add', (req, res) => {
  const { username, contact } = req.body;
  const user = db.users[username];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!db.users[contact]) return res.status(404).json({ error: 'Contact not found' });
  if (user.contacts.includes(contact)) return res.status(409).json({ error: 'Already added' });
  user.contacts.push(contact);
  if (!user.chats[contact]) user.chats[contact] = [];
  res.json({ success: true });
});

app.get('/api/messages/:username/:contactId', (req, res) => {
  const user = db.users[req.params.username];
  res.json({ messages: user?.chats?.[req.params.contactId] || [] });
});

io.on('connection', (socket) => {
  socket.on('join', (username) => socket.join(username));
  socket.on('send_message', (data) => {
    const { from, to, text, file } = data;
    const sender = db.users[from], receiver = db.users[to];
    if (!sender || !receiver) return;
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const msg = { from: 'me', text, file, time: now };
    const rcvMsg = { ...msg, from: 'them' };
    if (!sender.chats[to]) sender.chats[to] = [];
    if (!receiver.chats[from]) receiver.chats[from] = [];
    sender.chats[to].push(msg);
    receiver.chats[from].push(rcvMsg);
    io.to(to).emit('new_message', { from, message: rcvMsg });
  });
});

server.listen(3000, () => console.log('🚀 Server on http://localhost:3000'));