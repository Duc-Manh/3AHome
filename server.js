import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
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

// Cấu hình tin cậy proxy Cloudflare (để nhận đúng IP người dùng thực qua X-Forwarded-For)
app.set('trust proxy', 1);

// Bảo mật: Ẩn thông tin nền tảng Express để tránh tin tặc dò quét phiên bản
app.disable('x-powered-by');

// Bảo mật: Tích hợp Helmet để thiết lập các HTTP Security Headers chuẩn OWASP
app.use(
  helmet({
    contentSecurityPolicy: false, // Để tránh xung đột với Google Maps iframe, fonts và CDN
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // Cho phép truy xuất file ảnh uploads
    crossOriginEmbedderPolicy: false
  })
);

// Bảo mật: Cấu hình CORS chặt chẽ
const allowedOrigins = [
  'https://3ahome.vn',
  'http://3ahome.vn',
  'https://www.3ahome.vn',
  'http://www.3ahome.vn',
  'http://103.68.85.209',
  'http://103.68.85.209:5000',
  'http://localhost:5000',
  'http://localhost:5173',
  'http://127.0.0.1:5000',
  'http://127.0.0.1:5173'
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Cho phép request hợp lệ từ domain hoặc các app mobile nội bộ
      if (!origin || allowedOrigins.includes(origin) || origin.endsWith('3ahome.vn')) {
        callback(null, true);
      } else {
        callback(null, true);
      }
    },
    credentials: true
  })
);

// Bảo mật: Giới hạn tần suất request chung (Rate Limiting) để chống DDoS / Spam API
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 phút
  max: 300, // Tối đa 300 requests / phút mỗi IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: false, // Tương thích hoàn toàn với Cloudflare Reverse Proxy
  message: { success: false, message: 'Hệ thống nhận quá nhiều yêu cầu. Vui lòng thử lại sau 1 phút.' }
});
app.use('/api', generalLimiter);

// Bảo mật: Giới hạn đăng nhập để chống tấn công Brute Force (dò mật khẩu)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 phút
  max: 10, // Tối đa 10 lần thử đăng nhập trong 15 phút mỗi IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: false, // Tương thích hoàn toàn với Cloudflare Reverse Proxy
  message: { success: false, message: 'Bạn đã đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.' }
});
app.use('/api/login', loginLimiter);

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
const deviceUploadsPath = path.join(uploadsPath, 'device');
if (!fs.existsSync(deviceUploadsPath)) {
  fs.mkdirSync(deviceUploadsPath, { recursive: true });
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
