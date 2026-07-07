const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ============================================================
//  DATABASE
// ============================================================
const db = {
  users: {},        // username -> { password, contacts: [], chats: {}, pendingRequests: [] }
};

// ============================================================
//  REST API
// ============================================================
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  if (db.users[username]) return res.status(409).json({ error: 'User already exists' });
  db.users[username] = {
    password,
    contacts: [],
    chats: {},
    pendingRequests: []
  };
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
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ contacts: user.contacts || [] });
});

app.get('/api/messages/:username/:contactId', (req, res) => {
  const user = db.users[req.params.username];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const messages = user.chats?.[req.params.contactId] || [];
  res.json({ messages });
});

// ============================================================
//  WEBSOCKET EVENTS
// ============================================================
io.on('connection', (socket) => {
  let currentUser = null;

  socket.on('join', (username) => {
    currentUser = username;
    socket.join(username);
    console.log(`${username} joined`);
    // Send pending friend requests
    const user = db.users[username];
    if (user && user.pendingRequests && user.pendingRequests.length > 0) {
      socket.emit('pending_requests', user.pendingRequests);
    }
  });

  // ---------- FRIEND REQUESTS ----------
  socket.on('send_friend_request', (data) => {
    const { from, to } = data;
    const fromUser = db.users[from];
    const toUser = db.users[to];
    if (!fromUser || !toUser) return;
    if (fromUser.contacts.includes(to)) {
      io.to(from).emit('friend_request_error', { message: 'Already friends' });
      return;
    }
    if (toUser.pendingRequests.includes(from)) {
      io.to(from).emit('friend_request_error', { message: 'Request already sent' });
      return;
    }
    toUser.pendingRequests.push(from);
    io.to(to).emit('friend_request', { from });
  });

  socket.on('accept_friend_request', (data) => {
    const { username, requester } = data;
    const user = db.users[username];
    const requesterUser = db.users[requester];
    if (!user || !requesterUser) return;

    // Remove from pending
    user.pendingRequests = user.pendingRequests.filter(r => r !== requester);
    // Add to contacts
    if (!user.contacts.includes(requester)) user.contacts.push(requester);
    if (!requesterUser.contacts.includes(username)) requesterUser.contacts.push(username);
    // Initialize chat
    if (!user.chats[requester]) user.chats[requester] = [];
    if (!requesterUser.chats[username]) requesterUser.chats[username] = [];

    io.to(username).emit('friend_request_accepted', { requester });
    io.to(requester).emit('friend_request_accepted', { by: username });
    io.to(username).emit('contacts_updated');
    io.to(requester).emit('contacts_updated');
  });

  socket.on('decline_friend_request', (data) => {
    const { username, requester } = data;
    const user = db.users[username];
    if (!user) return;
    user.pendingRequests = user.pendingRequests.filter(r => r !== requester);
    io.to(requester).emit('friend_request_declined', { by: username });
  });

  // ---------- MESSAGES ----------
  socket.on('send_message', (data) => {
    const { from, to, text, file } = data;
    const sender = db.users[from];
    const receiver = db.users[to];
    if (!sender || !receiver) return;

    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const msg = { from: 'me', text, file, time: now };
    const rcvMsg = { ...msg, from: 'them' };

    if (!sender.chats[to]) sender.chats[to] = [];
    if (!receiver.chats[from]) receiver.chats[from] = [];

    sender.chats[to].push(msg);
    receiver.chats[from].push(rcvMsg);

    io.to(to).emit('new_message', { from, message: rcvMsg });
    io.to(from).emit('message_sent', { to, message: msg });
  });

  // ---------- CLEAR CHAT ----------
  socket.on('clear_chat', (data) => {
    const { username, contactId } = data;
    const user = db.users[username];
    const contact = db.users[contactId];
    if (!user || !contact) return;

    user.chats[contactId] = [];
    contact.chats[username] = [];

    io.to(username).emit('chat_cleared', { contactId });
    io.to(contactId).emit('chat_cleared', { contactId: username });
  });

  // ---------- CALL SIGNALING ----------
  socket.on('initiate_call', (data) => {
    const { from, to, type } = data;
    const fromUser = db.users[from];
    const toUser = db.users[to];
    if (!fromUser || !toUser) return;

    // Check if contact exists
    if (!fromUser.contacts.includes(to)) {
      io.to(from).emit('call_error', { message: 'Not a contact' });
      return;
    }

    io.to(to).emit('incoming_call', { from, type });
  });

  socket.on('accept_call', (data) => {
    const { from, to } = data;
    io.to(from).emit('call_accepted', { by: to });
    io.to(to).emit('call_connected', { with: from });
  });

  socket.on('decline_call', (data) => {
    const { from, to } = data;
    io.to(from).emit('call_declined', { by: to });
  });

  socket.on('end_call', (data) => {
    const { from, to } = data;
    io.to(to).emit('call_ended', { by: from });
    io.to(from).emit('call_ended', { by: to });
  });

  socket.on('call_mute_toggle', (data) => {
    const { from, to, muted } = data;
    io.to(to).emit('call_mute_toggled', { from, muted });
  });

  socket.on('call_video_toggle', (data) => {
    const { from, to, videoOn } = data;
    io.to(to).emit('call_video_toggled', { from, videoOn });
  });

  // ---------- DISCONNECT ----------
  socket.on('disconnect', () => {
    if (currentUser) {
      console.log(`${currentUser} disconnected`);
      // Notify contacts? Could add presence later.
    }
  });
});

// ============================================================
//  START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 ChatVerse server running on port ${PORT}`);
});