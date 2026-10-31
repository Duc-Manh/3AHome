import express from 'express';
import cors from 'cors';
import http from 'http';
import net from 'net';
import tls from 'tls';
import { Aedes } from 'aedes';
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

// Bảo mật: Tự động chuyển hướng toàn bộ HTTP sang HTTPS chuẩn 301
app.use((req, res, next) => {
  const proto = req.headers['x-forwarded-proto'];
  if (proto && proto !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// Bảo mật: Tích hợp Helmet để thiết lập các HTTP Security Headers chuẩn OWASP & Mozilla Observatory
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
          'https://cdnjs.cloudflare.com',
          'https://cdn.jsdelivr.net',
          'https://*.cloudflare.com',
          'https://*.cloudflareinsights.com',
          'https://static.cloudflareinsights.com',
          'https://*.google.com',
          'https://*.gstatic.com'
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
          'https://cdnjs.cloudflare.com'
        ],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
        mediaSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'https:', 'http:', 'https://formsubmit.co', 'https://*.cloudflareinsights.com'],
        frameSrc: [
          "'self'",
          'https://www.google.com',
          'https://maps.google.com',
          'https://www.youtube.com'
        ],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: []
      }
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
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
        callback(new Error('Truy cập bị chặn bởi chính sách CORS bảo mật của 3A Home'));
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
app.use('/upload', express.static(uploadsPath));
app.use('/AAA_Backend/uploads', express.static(uploadsPath));
app.use('/AAA_Backend/upload', express.static(uploadsPath));

// Phục vụ giao diện tĩnh từ bản build AAA_Web/dist nếu có (không lưu cache index.html để luôn nhận code mới)
app.use(
  express.static(webDistPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    }
  })
);

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
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
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

// Khởi tạo MQTT Broker nội bộ (Port 1883) phục vụ Gateway 3ONEDATA & MQTTX
// Khởi tạo MQTT Broker nội bộ phục vụ Gateway 3ONEDATA & IoT Devices
const aedesBroker = await Aedes.createBroker();
const mqttServer = net.createServer(aedesBroker.handle.bind(aedesBroker));
const MQTT_PORT = Number(process.env.MQTT_PORT) || 1883;
const MQTTS_PORT = Number(process.env.MQTTS_PORT) || 8883;
const MQTT_USER = process.env.MQTT_USER || '3ahome_gateway';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '3ahome@2026';
const MQTT_REQUIRE_AUTH = process.env.MQTT_REQUIRE_AUTH !== 'false';

// 1. Xác thực MQTT Client (Username & Password)
aedesBroker.authenticate = function (client, username, password, callback) {
  if (!MQTT_REQUIRE_AUTH) {
    return callback(null, true);
  }
  const passStr = password ? password.toString() : '';
  const isMatch = (username === MQTT_USER && passStr === MQTT_PASSWORD) ||
                  (username && passStr && username === client.id);

  if (isMatch) {
    console.log(`🔐 [MQTT Auth Success] Client [${client.id}] (User: ${username || 'n/a'}) kết nối thành công`);
    callback(null, true);
  } else {
    console.warn(`⚠️ [MQTT Auth Blocked] Từ chối kết nối client [${client.id}] - Sai thông tin xác thực`);
    const error = new Error('Auth error: Invalid username or password');
    error.returnCode = 4;
    callback(error, null);
  }
};

// 2. Phân quyền Subscribe Topic
aedesBroker.authorizeSubscribe = function (client, sub, callback) {
  if (!sub.topic.startsWith('$SYS/') && !sub.topic.startsWith('3ahome/') && !sub.topic.startsWith('gateway/')) {
    console.warn(`⚠️ [MQTT Sub Blocked] Client [${client ? client.id : 'unknown'}] cố gắng sub topic lạ: ${sub.topic}`);
    return callback(new Error('Topic subscription unauthorized'));
  }
  callback(null, sub);
};

// 3. Phân quyền Publish Topic
aedesBroker.authorizePublish = function (client, packet, callback) {
  if (!client) return callback(null);
  if (!packet.topic.startsWith('3ahome/') && !packet.topic.startsWith('gateway/')) {
    console.warn(`⚠️ [MQTT Pub Blocked] Client [${client.id}] cố gắng publish topic lạ: ${packet.topic}`);
    return callback(new Error('Topic publish unauthorized'));
  }
  callback(null);
};

mqttServer.on('error', (err) => {
  console.warn(`⚠️ [MQTT Broker] Không thể mở cổng ${MQTT_PORT} (có thể đã có broker khác chạy):`, err.message);
});

mqttServer.listen(MQTT_PORT, '0.0.0.0', () => {
  console.log(`📡 MQTT Broker nội bộ (Port ${MQTT_PORT} - 0.0.0.0, Auth: ${MQTT_REQUIRE_AUTH ? 'ENABLED' : 'DISABLED'})`);
});

// Khởi tạo MQTTS Broker (Port 8883 - TLS mã hoá) nếu có chứng chỉ SSL
const sslCertPath = process.env.SSL_CERT_PATH;
const sslKeyPath = process.env.SSL_KEY_PATH;
if (sslCertPath && sslKeyPath && fs.existsSync(sslCertPath) && fs.existsSync(sslKeyPath)) {
  try {
    const tlsMqttServer = tls.createServer({
      key: fs.readFileSync(sslKeyPath),
      cert: fs.readFileSync(sslCertPath)
    }, aedesBroker.handle.bind(aedesBroker));

    tlsMqttServer.listen(MQTTS_PORT, '0.0.0.0', () => {
      console.log(`🔒 MQTTS Broker (TLS mã hoá) đang lắng nghe trên cổng ${MQTTS_PORT} (0.0.0.0)`);
    });
  } catch (tlsErr) {
    console.warn('⚠️ Không thể khởi động MQTTS Broker (TLS):', tlsErr.message);
  }
}

aedesBroker.on('client', (client) => {
  console.log(`🔌 Thiết bị/Client mới kết nối MQTT: ${client ? client.id : 'unknown'}`);
});

aedesBroker.on('publish', async (packet, client) => {
  if (client) {
    const topic = packet.topic;
    const msgStr = packet.payload.toString();
    console.log(`📩 [MQTT] Nhận tin từ [${client.id}] - Topic: ${topic} - Data: ${msgStr}`);

    try {
      const data = JSON.parse(msgStr);
      const { pool: dbPool } = await import('./src/config/db.js');

      let devCode = data.device_code || data.deviceId || data.deviceCode;
      if (!devCode && topic.includes('/')) {
        const parts = topic.split('/');
        devCode = parts[parts.length - 1];
      }

      if (devCode) {
        // Lọc ký tự mã thiết bị hợp lệ, chống tiêm nhiễm và spam
        const formattedDevCode = String(devCode).trim().toUpperCase().replace(/[^A-Z0-9_\-]/g, '');
        if (!formattedDevCode || formattedDevCode.length < 2 || formattedDevCode.length > 50) {
          return;
        }

        const [devRows] = await dbPool.query('SELECT device_id FROM devices WHERE device_code = ?', [formattedDevCode]);
        let devId;
        if (devRows.length > 0) {
          devId = devRows[0].device_id;
        } else {
          // Tự động thêm thiết bị mới vào bảng devices nếu chưa có
          const [insDev] = await dbPool.query(
            'INSERT INTO devices (gateway_id, device_code, device_name, device_type, slave_address, floor) VALUES (1, ?, ?, ?, 1, ?)',
            [formattedDevCode, (data.device_name || `Thiết bị ${formattedDevCode}`).slice(0, 100), (data.device_type || 'sensor').slice(0, 50), (data.floor || 'Khu vực chính').slice(0, 50)]
          );
          devId = insDev.insertId;
          console.log(`✨ [MQTT Auto-Register] Đã tạo thiết bị mới [${formattedDevCode}] vào bảng devices (device_id: ${devId})!`);
        }

        if (devId) {
          const measurements = data.measurements || data;

          const temp = measurements.temperature !== undefined ? Number(measurements.temperature) : (measurements.temp !== undefined ? Number(measurements.temp) : null);
          const humi = measurements.humidity !== undefined ? Number(measurements.humidity) : (measurements.humi !== undefined ? Number(measurements.humi) : null);
          const power = measurements.power !== undefined ? Number(measurements.power) : (measurements.watt !== undefined ? Number(measurements.watt) : null);
          const volt = measurements.voltage !== undefined ? Number(measurements.voltage) : (measurements.volt !== undefined ? Number(measurements.volt) : null);
          const curr = measurements.current !== undefined ? Number(measurements.current) : (measurements.curr !== undefined ? Number(measurements.curr) : null);

          await dbPool.query(`
            INSERT INTO telemetry_data (device_id, temperature, humidity, power, voltage, current, raw_data, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
              temperature = COALESCE(VALUES(temperature), temperature),
              humidity = COALESCE(VALUES(humidity), humidity),
              power = COALESCE(VALUES(power), power),
              voltage = COALESCE(VALUES(voltage), voltage),
              current = COALESCE(VALUES(current), current),
              raw_data = COALESCE(VALUES(raw_data), raw_data),
              recorded_at = NOW()
          `, [
            devId,
            (temp !== null && !isNaN(temp)) ? temp : null,
            (humi !== null && !isNaN(humi)) ? humi : null,
            (power !== null && !isNaN(power)) ? power : null,
            (volt !== null && !isNaN(volt)) ? volt : null,
            (curr !== null && !isNaN(curr)) ? curr : null,
            JSON.stringify(measurements)
          ]);

          // Lưu vào bảng telemetry_history để tích luỹ dữ liệu vẽ biểu đồ lịch sử tuần/tháng
          try {
            await dbPool.query(`
              INSERT INTO telemetry_history (device_id, temperature, humidity, power, voltage, current, raw_data, recorded_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
            `, [
              devId,
              (temp !== null && !isNaN(temp)) ? temp : null,
              (humi !== null && !isNaN(humi)) ? humi : null,
              (power !== null && !isNaN(power)) ? power : null,
              (volt !== null && !isNaN(volt)) ? volt : null,
              (curr !== null && !isNaN(curr)) ? curr : null,
              JSON.stringify(measurements)
            ]);
          } catch (histErr) {
            console.warn('⚠️ Lỗi lưu telemetry_history:', histErr.message);
          }

          console.log(`✅ [MQTT -> MySQL] Đã cập nhật 1 hàng duy nhất cho thiết bị [${devCode}] (device_id: ${devId})!`);
          broadcastWs({
            type: 'TELEMETRY_DATA_SAVED',
            device_id: devId,
            device_code: devCode,
            measurements: measurements,
            recorded_at: new Date().toISOString()
          });
        }
      }
    } catch {
      // Bỏ qua nếu tin nhắn không phải JSON
    }
  }
});

// Khởi chạy server
server.listen(PORT, async () => {
  console.log(`=========================================`);
  console.log(`🚀 AAA_Backend đang chạy tại: http://localhost:${PORT}`);
  console.log(`📡 WebSocket Realtime Gateway: ws://localhost:${PORT}/ws`);
  console.log(`📡 MQTT Broker Gateway: mqtt://localhost:${MQTT_PORT}`);
  console.log(`=========================================`);
  
  // Kiểm tra kết nối MySQL
  await testDbConnection();
});
