'use strict';
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const Database = require('better-sqlite3');

const http    = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET || 'commsmeme_secret_change_in_prod_' + Math.random().toString(36);
const PORT       = process.env.PORT || 3001;
const FRONTEND   = path.join(__dirname, '..', 'frontend');

// ── DATABASE ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT    UNIQUE NOT NULL,
    name           TEXT    NOT NULL,
    password_hash  TEXT    NOT NULL,
    bio            TEXT    DEFAULT '',
    followers      INTEGER DEFAULT 0,
    following_count INTEGER DEFAULT 0,
    created_at     INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS follows (
    follower  TEXT NOT NULL,
    following TEXT NOT NULL,
    PRIMARY KEY (follower, following)
  );

  CREATE TABLE IF NOT EXISTS posts (
    id         TEXT    PRIMARY KEY,
    username   TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    comm_id    TEXT    DEFAULT NULL,
    likes      INTEGER DEFAULT 0,
    reposts    INTEGER DEFAULT 0,
    replies    INTEGER DEFAULT 0,
    ts         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS likes (
    username TEXT NOT NULL,
    post_id  TEXT NOT NULL,
    PRIMARY KEY (username, post_id)
  );

  CREATE TABLE IF NOT EXISTS reposts_table (
    username TEXT NOT NULL,
    post_id  TEXT NOT NULL,
    PRIMARY KEY (username, post_id)
  );

  CREATE TABLE IF NOT EXISTS communities (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL,
    description TEXT    DEFAULT '',
    icon        TEXT    DEFAULT '👥',
    color       TEXT    DEFAULT '#1d9bf0',
    created_by  TEXT    NOT NULL,
    members     INTEGER DEFAULT 1,
    created_at  INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS community_members (
    community_id TEXT NOT NULL,
    username     TEXT NOT NULL,
    PRIMARY KEY (community_id, username)
  );

  CREATE TABLE IF NOT EXISTS chats (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL DEFAULT 'dm',
    name       TEXT,
    created_by TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id  TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (chat_id, username)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id   TEXT    NOT NULL,
    from_user TEXT    NOT NULL,
    text      TEXT    NOT NULL,
    ts        INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_posts_ts       ON posts(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_comm     ON posts(comm_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_chat  ON messages(chat_id, ts);
`);

// ── MIDDLEWARE ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(FRONTEND));          // serves index.html + assets

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── AUTH ───────────────────────────────────────────────────────────────────────
app.post('/api/auth/signup', (req, res) => {
  const { username, name, password } = req.body || {};
  if (!username || !name || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (!/^[a-zA-Z0-9_]{1,30}$/.test(username))
    return res.status(400).json({ error: 'Username: letters, numbers, underscores only (max 30)' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const hash = bcrypt.hashSync(password, 10);
  try {
    db.prepare('INSERT INTO users (username, name, password_hash) VALUES (?,?,?)').run(username, name.trim(), hash);
    const token = jwt.sign({ username, name: name.trim() }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { username, name: name.trim(), bio: '', followers: 0, following_count: 0 } });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already taken' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get((username || '').replace('@', '').trim());
  if (!u || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ username: u.username, name: u.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { username: u.username, name: u.name, bio: u.bio, followers: u.followers, following_count: u.following_count } });
});

// ── POSTS (global feed) ───────────────────────────────────────────────────────
const postSelect = (viewerParam) => `
  SELECT p.id, p.username, p.text, p.comm_id, p.likes, p.reposts, p.replies, p.ts,
         u.name,
         CASE WHEN l.username  IS NOT NULL THEN 1 ELSE 0 END AS liked,
         CASE WHEN r.username  IS NOT NULL THEN 1 ELSE 0 END AS reposted,
         c.name  AS comm_name,
         c.icon  AS comm_icon,
         c.color AS comm_color
  FROM posts p
  JOIN users u ON u.username = p.username
  LEFT JOIN likes          l ON l.post_id = p.id AND l.username = ${viewerParam}
  LEFT JOIN reposts_table  r ON r.post_id = p.id AND r.username = ${viewerParam}
  LEFT JOIN communities    c ON c.id = p.comm_id
`;

app.get('/api/posts', auth, (req, res) => {
  const rows = db.prepare(postSelect('?') + ' ORDER BY p.ts DESC LIMIT 100').all(req.user.username, req.user.username);
  res.json(rows);
});

app.get('/api/posts/:id', auth, (req, res) => {
  const row = db.prepare(postSelect('?') + ' WHERE p.id = ?').get(req.user.username, req.user.username, req.params.id);
  if (!row) return res.status(404).json({ error: 'Post not found' });
  res.json(row);
});

// Public post endpoint (no auth needed — for sharing)
app.get('/api/posts/:id/public', (req, res) => {
  const row = db.prepare(`
    SELECT p.id, p.username, p.text, p.comm_id, p.likes, p.reposts, p.replies, p.ts,
           u.name, c.name AS comm_name, c.icon AS comm_icon, c.color AS comm_color,
           0 AS liked, 0 AS reposted
    FROM posts p
    JOIN users u ON u.username = p.username
    LEFT JOIN communities c ON c.id = p.comm_id
    WHERE p.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Post not found' });
  res.json(row);
});

app.post('/api/posts', auth, (req, res) => {
  const { text, comm_id } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'Text required' });
  if (text.length > 280) return res.status(400).json({ error: 'Too long (max 280)' });

  // If posting to a community, user must be a member
  if (comm_id) {
    const isMember = db.prepare('SELECT 1 FROM community_members WHERE community_id=? AND username=?').get(comm_id, req.user.username);
    if (!isMember) return res.status(403).json({ error: 'Join this community first' });
  }

  const id = 'p' + Date.now() + Math.random().toString(36).slice(2, 6);
  db.prepare('INSERT INTO posts (id, username, text, comm_id, ts) VALUES (?,?,?,?,?)').run(id, req.user.username, text.trim(), comm_id || null, Date.now());

  const post = db.prepare(postSelect('?') + ' WHERE p.id = ?').get(req.user.username, req.user.username, id);
  // Broadcast to all connected sockets (they decide whether to show it)
  io.emit('new_post', post);
  res.json(post);
});

app.post('/api/posts/:id/like', auth, (req, res) => {
  const { id } = req.params;
  if (!db.prepare('SELECT 1 FROM posts WHERE id=?').get(id)) return res.status(404).json({ error: 'Post not found' });
  const exists = db.prepare('SELECT 1 FROM likes WHERE username=? AND post_id=?').get(req.user.username, id);
  if (exists) {
    db.prepare('DELETE FROM likes WHERE username=? AND post_id=?').run(req.user.username, id);
    db.prepare('UPDATE posts SET likes = MAX(0, likes-1) WHERE id=?').run(id);
    res.json({ liked: false });
  } else {
    db.prepare('INSERT OR IGNORE INTO likes (username, post_id) VALUES (?,?)').run(req.user.username, id);
    db.prepare('UPDATE posts SET likes = likes+1 WHERE id=?').run(id);
    res.json({ liked: true });
  }
});

app.post('/api/posts/:id/repost', auth, (req, res) => {
  const { id } = req.params;
  if (!db.prepare('SELECT 1 FROM posts WHERE id=?').get(id)) return res.status(404).json({ error: 'Post not found' });
  const exists = db.prepare('SELECT 1 FROM reposts_table WHERE username=? AND post_id=?').get(req.user.username, id);
  if (exists) {
    db.prepare('DELETE FROM reposts_table WHERE username=? AND post_id=?').run(req.user.username, id);
    db.prepare('UPDATE posts SET reposts = MAX(0, reposts-1) WHERE id=?').run(id);
    res.json({ reposted: false });
  } else {
    db.prepare('INSERT OR IGNORE INTO reposts_table (username, post_id) VALUES (?,?)').run(req.user.username, id);
    db.prepare('UPDATE posts SET reposts = reposts+1 WHERE id=?').run(id);
    res.json({ reposted: true });
  }
});

// ── USERS ─────────────────────────────────────────────────────────────────────
app.get('/api/users/suggestions/list', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT u.username, u.name, u.bio, u.followers,
      CASE WHEN f.follower IS NOT NULL THEN 1 ELSE 0 END AS isFollowing
    FROM users u
    LEFT JOIN follows f ON f.follower=? AND f.following=u.username
    WHERE u.username != ?
    ORDER BY u.followers DESC LIMIT 5
  `).all(req.user.username, req.user.username);
  res.json(rows);
});

app.get('/api/users/search', auth, (req, res) => {
  const q = '%' + (req.query.q || '') + '%';
  const rows = db.prepare('SELECT username, name, bio FROM users WHERE username LIKE ? OR name LIKE ? LIMIT 10').all(q, q);
  res.json(rows);
});

app.get('/api/users/:username', auth, (req, res) => {
  const u = db.prepare('SELECT username, name, bio, followers, following_count FROM users WHERE username=?').get(req.params.username);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const isFollowing = !!db.prepare('SELECT 1 FROM follows WHERE follower=? AND following=?').get(req.user.username, req.params.username);
  const posts = db.prepare(postSelect('?') + ' WHERE p.username=? ORDER BY p.ts DESC').all(req.user.username, req.user.username, req.params.username);
  res.json({ ...u, isFollowing, posts });
});

app.post('/api/users/:username/follow', auth, (req, res) => {
  const target = req.params.username;
  if (target === req.user.username) return res.status(400).json({ error: 'Cannot follow yourself' });
  const exists = db.prepare('SELECT 1 FROM follows WHERE follower=? AND following=?').get(req.user.username, target);
  if (exists) {
    db.prepare('DELETE FROM follows WHERE follower=? AND following=?').run(req.user.username, target);
    db.prepare('UPDATE users SET followers      = MAX(0, followers-1)       WHERE username=?').run(target);
    db.prepare('UPDATE users SET following_count = MAX(0, following_count-1) WHERE username=?').run(req.user.username);
    res.json({ following: false });
  } else {
    db.prepare('INSERT OR IGNORE INTO follows (follower, following) VALUES (?,?)').run(req.user.username, target);
    db.prepare('UPDATE users SET followers      = followers+1       WHERE username=?').run(target);
    db.prepare('UPDATE users SET following_count = following_count+1 WHERE username=?').run(req.user.username);
    res.json({ following: true });
  }
});

// ── COMMUNITIES ───────────────────────────────────────────────────────────────
app.get('/api/communities', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, CASE WHEN cm.username IS NOT NULL THEN 1 ELSE 0 END AS joined
    FROM communities c
    LEFT JOIN community_members cm ON cm.community_id=c.id AND cm.username=?
    ORDER BY c.members DESC
  `).all(req.user.username);
  res.json(rows);
});

// Public community info (for invite links — no auth needed)
app.get('/api/communities/:id/public', (req, res) => {
  const c = db.prepare('SELECT id, name, description, icon, color, members, created_by FROM communities WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Community not found' });
  res.json(c);
});

app.get('/api/communities/:id', auth, (req, res) => {
  const c = db.prepare(`
    SELECT c.*, CASE WHEN cm.username IS NOT NULL THEN 1 ELSE 0 END AS joined
    FROM communities c
    LEFT JOIN community_members cm ON cm.community_id=c.id AND cm.username=?
    WHERE c.id=?
  `).get(req.user.username, req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const posts = db.prepare(postSelect('?') + ' WHERE p.comm_id=? ORDER BY p.ts DESC LIMIT 100').all(req.user.username, req.user.username, req.params.id);
  const members = db.prepare('SELECT cm.username, u.name FROM community_members cm JOIN users u ON u.username=cm.username WHERE cm.community_id=?').all(req.params.id);
  res.json({ ...c, posts, members });
});

app.post('/api/communities', auth, (req, res) => {
  const { name, description, icon, color } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const id = 'comm_' + Date.now();
  db.prepare('INSERT INTO communities (id, name, description, icon, color, created_by) VALUES (?,?,?,?,?,?)').run(
    id, name.trim(), description || '', icon || '👥', color || '#1d9bf0', req.user.username
  );
  db.prepare('INSERT INTO community_members (community_id, username) VALUES (?,?)').run(id, req.user.username);
  const comm = db.prepare('SELECT * FROM communities WHERE id=?').get(id);
  res.json({ ...comm, joined: 1 });
});

app.post('/api/communities/:id/join', auth, (req, res) => {
  const { id } = req.params;
  if (!db.prepare('SELECT 1 FROM communities WHERE id=?').get(id)) return res.status(404).json({ error: 'Community not found' });
  const exists = db.prepare('SELECT 1 FROM community_members WHERE community_id=? AND username=?').get(id, req.user.username);
  if (exists) {
    db.prepare('DELETE FROM community_members WHERE community_id=? AND username=?').run(id, req.user.username);
    db.prepare('UPDATE communities SET members = MAX(0, members-1) WHERE id=?').run(id);
    res.json({ joined: false });
  } else {
    db.prepare('INSERT OR IGNORE INTO community_members (community_id, username) VALUES (?,?)').run(id, req.user.username);
    db.prepare('UPDATE communities SET members = members+1 WHERE id=?').run(id);
    res.json({ joined: true });
  }
});

// ── MESSAGES ──────────────────────────────────────────────────────────────────
app.get('/api/chats', auth, (req, res) => {
  const chats = db.prepare(`
    SELECT c.*,
      (SELECT text FROM messages WHERE chat_id=c.id ORDER BY ts DESC LIMIT 1) AS last_message,
      (SELECT ts   FROM messages WHERE chat_id=c.id ORDER BY ts DESC LIMIT 1) AS last_ts,
      (SELECT COUNT(*) FROM messages WHERE chat_id=c.id AND from_user != ?) AS unread
    FROM chats c
    JOIN chat_members cm ON cm.chat_id=c.id AND cm.username=?
    ORDER BY last_ts DESC
  `).all(req.user.username, req.user.username);

  res.json(chats.map(chat => {
    const members = db.prepare('SELECT username FROM chat_members WHERE chat_id=?').all(chat.id).map(r => r.username);
    return { ...chat, members };
  }));
});

app.post('/api/chats/dm', auth, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const target = db.prepare('SELECT username, name FROM users WHERE username=?').get(username);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const existing = db.prepare(`
    SELECT c.id FROM chats c
    JOIN chat_members cm1 ON cm1.chat_id=c.id AND cm1.username=?
    JOIN chat_members cm2 ON cm2.chat_id=c.id AND cm2.username=?
    WHERE c.type='dm'
  `).get(req.user.username, username);
  if (existing) return res.json({ id: existing.id, name: target.name, type: 'dm', existing: true });

  const id = 'dm_' + Date.now();
  db.prepare('INSERT INTO chats (id, type, name, created_by) VALUES (?,?,?,?)').run(id, 'dm', target.name, req.user.username);
  db.prepare('INSERT INTO chat_members (chat_id, username) VALUES (?,?)').run(id, req.user.username);
  db.prepare('INSERT INTO chat_members (chat_id, username) VALUES (?,?)').run(id, username);
  res.json({ id, type: 'dm', name: target.name, members: [req.user.username, username] });
});

app.post('/api/chats/group', auth, (req, res) => {
  const { name, members } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Group name required' });
  const id = 'grp_' + Date.now();
  db.prepare('INSERT INTO chats (id, type, name, created_by) VALUES (?,?,?,?)').run(id, 'group', name.trim(), req.user.username);
  db.prepare('INSERT INTO chat_members (chat_id, username) VALUES (?,?)').run(id, req.user.username);
  (members || []).forEach(m => {
    if (m !== req.user.username && db.prepare('SELECT 1 FROM users WHERE username=?').get(m))
      db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, username) VALUES (?,?)').run(id, m);
  });
  const allMembers = db.prepare('SELECT username FROM chat_members WHERE chat_id=?').all(id).map(r => r.username);
  res.json({ id, type: 'group', name: name.trim(), members: allMembers });
});

app.get('/api/chats/:id/messages', auth, (req, res) => {
  if (!db.prepare('SELECT 1 FROM chat_members WHERE chat_id=? AND username=?').get(req.params.id, req.user.username))
    return res.status(403).json({ error: 'Not a member' });
  const msgs = db.prepare('SELECT * FROM messages WHERE chat_id=? ORDER BY ts ASC LIMIT 200').all(req.params.id);
  res.json(msgs);
});

app.post('/api/chats/:id/messages', auth, (req, res) => {
  const { text } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'Text required' });
  if (!db.prepare('SELECT 1 FROM chat_members WHERE chat_id=? AND username=?').get(req.params.id, req.user.username))
    return res.status(403).json({ error: 'Not a member' });

  const ts = Date.now();
  const result = db.prepare('INSERT INTO messages (chat_id, from_user, text, ts) VALUES (?,?,?,?)').run(req.params.id, req.user.username, text.trim(), ts);
  const saved = { id: result.lastInsertRowid, chat_id: req.params.id, from_user: req.user.username, text: text.trim(), ts };

  // Emit ONLY to OTHER sockets in this room (not the sender's socket)
  // The sender already gets the message via the HTTP response
  const senderSocketId = connectedUsers.get(req.user.username);
  io.to(req.params.id).except(senderSocketId || '__none__').emit('new_message', saved);

  res.json(saved);
});

// ── SOCKET.IO ─────────────────────────────────────────────────────────────────
const connectedUsers = new Map(); // username → socket.id

io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token || '', JWT_SECRET);
    next();
  } catch { next(new Error('Unauthorized')); }
});

io.on('connection', socket => {
  connectedUsers.set(socket.user.username, socket.id);
  socket.on('join_chat',  chatId => socket.join(chatId));
  socket.on('leave_chat', chatId => socket.leave(chatId));
  socket.on('disconnect', () => connectedUsers.delete(socket.user.username));
});

// ── SPA CATCH-ALL ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

server.listen(PORT, () => console.log(`🚀 commsmeme running on http://localhost:${PORT}`));