# 𝕏 Clone — Full Stack Social Network

A production-ready X (Twitter) clone with real backend, database, real-time messaging, and password-based authentication.

---

## Features
- ✅ Password authentication (min 8 characters) — no private keys
- ✅ Posts feed with likes & reposts
- ✅ Explore / search
- ✅ Communities with **Create Community** button
- ✅ Messages: DMs + **Create Group Chat** button
- ✅ Real-time messaging via Socket.io
- ✅ Follow / unfollow users
- ✅ SQLite database (zero config, file-based)
- ✅ JWT sessions (30-day tokens)

---

## Project Structure

```
xclone/
├── backend/
│   ├── server.js        ← Express API + Socket.io
│   ├── package.json
│   └── data.db          ← auto-created on first run
├── frontend/
│   └── index.html       ← Single-page app (served by backend)
└── README.md
```

---

## Quick Start (Local)

### 1. Install dependencies
```bash
cd backend
npm install
```

### 2. Start the server
```bash
node server.js
# or for development with auto-reload:
npm run dev
```

### 3. Open the app
```
http://localhost:3001
```

The backend automatically serves the `frontend/index.html` file.

---

## Deploy to Production

### Option A: Railway / Render / Fly.io (recommended)

1. Push your code to GitHub
2. Connect your repo to Railway or Render
3. Set these environment variables:
   ```
   JWT_SECRET=your_very_long_random_secret_here
   PORT=3001
   ```
4. Deploy — done!

**Important**: The `data.db` file won't persist on free Render instances (ephemeral storage). Use Railway or add a persistent disk. For production scale, swap `better-sqlite3` for PostgreSQL using `pg` or Prisma.

### Option B: VPS (DigitalOcean, Linode, etc.)

```bash
# Install Node 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone your repo
git clone <your-repo> && cd xclone/backend
npm install

# Run with PM2 (process manager)
npm install -g pm2
pm2 start server.js --name xclone
pm2 startup && pm2 save

# Nginx reverse proxy (optional, for port 80/443)
# proxy_pass http://localhost:3001;
```

### Option C: Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY backend/package*.json ./backend/
RUN cd backend && npm install
COPY . .
EXPOSE 3001
CMD ["node", "backend/server.js"]
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `JWT_SECRET` | auto-generated | **Change this in production!** |

---

## API Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/signup` | No | Create account |
| POST | `/api/auth/login` | No | Sign in |
| GET | `/api/posts` | Yes | Get feed |
| POST | `/api/posts` | Yes | Create post |
| POST | `/api/posts/:id/like` | Yes | Toggle like |
| POST | `/api/posts/:id/repost` | Yes | Toggle repost |
| GET | `/api/users/search?q=` | Yes | Search users |
| GET | `/api/users/:username` | Yes | Get user profile |
| POST | `/api/users/:username/follow` | Yes | Toggle follow |
| GET | `/api/communities` | Yes | List communities |
| POST | `/api/communities` | Yes | Create community |
| POST | `/api/communities/:id/join` | Yes | Join/leave community |
| GET | `/api/chats` | Yes | Get chat list |
| POST | `/api/chats/dm` | Yes | Start DM |
| POST | `/api/chats/group` | Yes | Create group chat |
| GET | `/api/chats/:id/messages` | Yes | Get messages |
| POST | `/api/chats/:id/messages` | Yes | Send message |

---

## Scaling Up

When you outgrow SQLite:
- Replace `better-sqlite3` with `pg` (PostgreSQL) or use Prisma ORM
- Add Redis for Socket.io scaling across multiple servers
- Add file upload (Cloudinary / S3) for profile photos and media
