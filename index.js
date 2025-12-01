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

// 新增：随机颜色生成函数
const generateColor = () => {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
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
    const color = generateColor(); // 新增：生成颜色
    socket.data.alias = alias;
    socket.data.color = color; // 存储颜色

    // 发送马甲和颜色给当前连接的客户端
    socket.emit('alias assigned', { alias, color });

    // 广播：用户加入通知
    const userConnectedMsg = `${alias} 加入了聊天室`;
    io.emit('server message', userConnectedMsg);
    
    // 广播：更新在线人数
    io.emit('user count', io.engine.clientsCount);

    socket.on('chat message', async (msg, clientOffset, callback) => {
      const alias = socket.data.alias;
      const color = socket.data.color;
      
      // 客户端接收的结构化消息
      const payload = {
          alias: alias,
          content: msg,
          color: color
      };
      
      // 数据库存储仍使用简单字符串格式
      const dbContent = `${alias}: ${msg}`;
      
      let result;
      try {
        result = await db.run('INSERT INTO messages (content, client_offset) VALUES (?, ?)', dbContent, clientOffset);
      } catch (e) {
        if (e.errno === 19 /* SQLITE_CONSTRAINT */ ) {
          callback();
        } else {
          // nothing to do, just let the client retry
        }
        return;
      }
      
      // 广播结构化消息
      io.emit('chat message', payload, result.lastID);
      callback();
    });

    socket.on('disconnect', () => {
        const alias = socket.data.alias;
        
        // 广播：用户离开通知
        const userDisconnectedMsg = `${alias} 离开了聊天室`;
        io.emit('server message', userDisconnectedMsg);
        
        // 广播：更新在线人数 (使用 setTimeout 确保 clientsCount 更新)
        setTimeout(() => {
             io.emit('user count', io.engine.clientsCount);
        }, 50);
    });

    if (!socket.recovered) {
      try {
        await db.each('SELECT id, content FROM messages WHERE id > ?',
          [socket.handshake.auth.serverOffset || 0],
          (_err, row) => {
            // 恢复逻辑：解析旧格式消息，并赋予默认颜色
            const parts = row.content.match(/(.+?): (.+)/);
            const recoveryPayload = {
                alias: parts ? parts[1] : '系统',
                content: parts ? parts[2] : row.content,
                color: '#888888' // 默认颜色用于历史消息
            };
            socket.emit('chat message', recoveryPayload, row.id);
          }
        )
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
