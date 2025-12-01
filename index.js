import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import { createAdapter, setupPrimary } from '@socket.io/cluster-adapter';

const ALIAS_ADJECTIVES = [
  '活力',
  '神秘',
  '勇敢',
  '快乐',
  '冷静',
  '机智',
  '可爱',
  '闪亮',
  '顽皮',
  '轻快'
];

const ALIAS_NOUNS = [
  '狐狸',
  '鲸鱼',
  '猫头鹰',
  '野猫',
  '海豚',
  '蜻蜓',
  '斑马',
  '麋鹿',
  '飞鸟',
  '纸飞机'
];

const generateAlias = () => {
  const adjective = ALIAS_ADJECTIVES[Math.floor(Math.random() * ALIAS_ADJECTIVES.length)];
  const noun = ALIAS_NOUNS[Math.floor(Math.random() * ALIAS_NOUNS.length)];
  const suffix = Math.floor(Math.random() * 900 + 100); // three digits
  return `${adjective}${noun}-${suffix}`;
};

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({
      PORT: 4000 + i
    });
  }

  setupPrimary();
} else {
  const db = await open({
    filename: 'chat.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT
    );
  `);

  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {},
    adapter: createAdapter()
  });

  const __dirname = dirname(fileURLToPath(import.meta.url));

  app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
  });

  io.on('connection', async (socket) => {
    const alias = generateAlias();
    socket.data.alias = alias;
    socket.emit('alias assigned', alias);

    socket.on('chat message', async (msg, clientOffset, callback) => {
      const payload = `${socket.data.alias}: ${msg}`;
      let result;
      try {
        result = await db.run('INSERT INTO messages (content, client_offset) VALUES (?, ?)', payload, clientOffset);
      } catch (e) {
        if (e.errno === 19 /* SQLITE_CONSTRAINT */ ) {
          callback();
        } else {
          // nothing to do, just let the client retry
        }
        return;
      }
      io.emit('chat message', payload, result.lastID);
      callback();
    });

    const sendRows = (rows, eventName = 'chat message') => {
      rows.forEach((row) => socket.emit(eventName, row.content, row.id));
    };

    socket.on('load history', async (earliestId = Number.MAX_SAFE_INTEGER, callback) => {
      try {
        const rows = await db.all(
          'SELECT id, content FROM messages WHERE id < ? ORDER BY id DESC LIMIT 10',
          earliestId
        );
        sendRows(rows.reverse(), 'chat message prepend');
        callback?.(rows.length);
      } catch (e) {
        callback?.(0);
      }
    });

    if (!socket.recovered) {
      const offset = socket.handshake.auth.serverOffset || 0;
      try {
        if (offset === 0) {
          const rows = await db.all(
            'SELECT id, content FROM messages ORDER BY id DESC LIMIT 10'
          );
          sendRows(rows.reverse());
        } else {
          const rows = await db.all(
            'SELECT id, content FROM messages WHERE id > ? ORDER BY id ASC',
            offset
          );
          sendRows(rows);
        }
      } catch (e) {
        // something went wrong
      }
    }
  });

  const port = process.env.PORT;

  server.listen(port, () => {
    console.log(`server running at http://localhost:${port}`);
  });
}
