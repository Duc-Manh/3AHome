import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { testDbConnection } from './src/config/db.js';
import { createApiRouter } from './src/routes/api.js';

import fs from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const localDist = path.resolve(__dirname, 'dist');
const webDistPath = fs.existsSync(localDist) ? localDist : path.resolve(__dirname, '../AAA_Web/dist');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Cho phép Web & Mobile App gọi API từ mọi nguồn IP
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Tạo thư mục uploads/news nếu chưa có và phục vụ static
const uploadsPath = path.resolve(__dirname, 'uploads');
const newsUploadsPath = path.join(uploadsPath, 'news');
if (!fs.existsSync(newsUploadsPath)) {
  fs.mkdirSync(newsUploadsPath, { recursive: true });
}
const projectUploadsPath = path.join(uploadsPath, 'project');
if (!fs.existsSync(projectUploadsPath)) {
  fs.mkdirSync(projectUploadsPath, { recursive: true });
}
app.use('/uploads', express.static(uploadsPath));

// Phục vụ giao diện tĩnh từ bản build AAA_Web/dist nếu có
app.use(express.static(webDistPath));

// Tạo HTTP Server kết hợp WebSocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Hàm phát thông báo tới tất cả Web & Mobile clients đang kết nối
function broadcastWs(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Xử lý kết nối WebSocket
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`🔌 Thiết bị/Web mới kết nối WebSocket từ IP: ${clientIp}`);

  ws.send(JSON.stringify({
    type: 'WELCOME',
    message: 'Kết nối thành công tới AAA_Backend Realtime Gateway'
  }));

  ws.on('close', () => {
    console.log(`🔌 Đã ngắt kết nối WebSocket: ${clientIp}`);
  });
});

// Đăng ký các tuyến API
app.use('/api', createApiRouter(broadcastWs));

// Tuyến fallback: Phục vụ Web AAA_Web (index.html) hoặc trả về thông tin API
app.get('*', (req, res, next) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
    return next();
  }
  const indexPath = path.join(webDistPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.json({
        project: 'AAA IoT Smart System Backend',
        version: '1.0.0',
        serverStatus: 'running',
        apiDocs: '/api/devices, /api/logs, /api/simu, /api/health',
        websocketEndpoint: '/ws'
      });
    }
  });
});

// Khởi chạy server
server.listen(PORT, async () => {
  console.log(`=========================================`);
  console.log(`🚀 AAA_Backend đang chạy tại: http://localhost:${PORT}`);
  console.log(`📡 WebSocket Realtime Gateway: ws://localhost:${PORT}/ws`);
  console.log(`=========================================`);
  
  // Kiểm tra kết nối MySQL
  await testDbConnection();
});
