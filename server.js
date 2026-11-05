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
// Tuân thủ RFC 6797: Tuyệt đối không gửi header Strict-Transport-Security trên kết nối HTTP không bảo mật
app.use((req, res, next) => {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  if (!isHttps && process.env.NODE_ENV === 'production') {
    res.removeHeader('Strict-Transport-Security');
    const host = req.headers.host || '3ahome.vn';
    return res.redirect(301, `https://${host}${req.url}`);
  }
  next();
});

// Bảo mật: Tích hợp Helmet để thiết lập các HTTP Security Headers chuẩn OWASP & Mozilla Observatory A+
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          'https://accounts.google.com',
          'https://cdnjs.cloudflare.com',
          'https://cdn.jsdelivr.net',
          'https://static.cloudflareinsights.com'
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
          'https://cdnjs.cloudflare.com'
        ],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'https://*.googleusercontent.com'],
        mediaSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: [
          "'self'",
          'ws:',
          'wss:',
          'https:',
          'https://formsubmit.co',
          'https://*.cloudflareinsights.com',
          'https://accounts.google.com',
          'https://www.googleapis.com'
        ],
        frameSrc: [
          "'self'",
          'https://www.google.com',
          'https://accounts.google.com',
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
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false
  })
);

// Bảo mật: Cấu hình CORS chặt chẽ (Hỗ trợ AAA_Web, AAA_Mobile và phần mềm Windows AAA_Software)
const allowedOrigins = [
  'https://3ahome.vn',
  'http://3ahome.vn',
  'https://www.3ahome.vn',
  'http://www.3ahome.vn',
  'https://api.3ahome.vn',
  'http://103.68.85.209',
  'http://103.68.85.209:5000',
  'http://localhost:5000',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'app://.',
  'file://'
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Cho phép request hợp lệ từ domain, app mobile và phần mềm Desktop AAA_Software (Electron/File protocol)
      if (
        !origin ||
        origin === 'null' ||
        origin.startsWith('file://') ||
        origin.startsWith('app://') ||
        allowedOrigins.includes(origin) ||
        origin.endsWith('3ahome.vn')
      ) {
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

// Bộ nhớ tạm chống lặp lại gói tin do chính server vừa publish lên broker ngoài
const recentSelfPublished = new Map();
function markSelfPublished(topic, payloadStr) {
  const key = `${topic}|${String(payloadStr).trim()}`;
  recentSelfPublished.set(key, Date.now());
  if (recentSelfPublished.size > 200) {
    const now = Date.now();
    for (const [k, ts] of recentSelfPublished.entries()) {
      if (now - ts > 5000) recentSelfPublished.delete(k);
    }
  }
}
function isRecentlySelfPublished(topic, payloadStr) {
  const key = `${topic}|${String(payloadStr).trim()}`;
  const ts = recentSelfPublished.get(key);
  if (!ts) return false;
  if (Date.now() - ts < 1800) {
    recentSelfPublished.delete(key);
    return true;
  }
  recentSelfPublished.delete(key);
  return false;
}

// Hàm gửi gói tin MQTT v3.1.1 nhanh qua TCP tới Broker ngoài (예: broker.hivemq.com:1883)
function publishToExternalBroker(host, port, topic, payloadStr) {
  try {
    markSelfPublished(topic, payloadStr);
    let sentPublish = false;
    const client = net.createConnection({ host, port, timeout: 4000 }, () => {
      const encodeLength = (len) => {
        const bytes = [];
        do {
          let digit = len % 128;
          len = Math.floor(len / 128);
          if (len > 0) digit |= 0x80;
          bytes.push(digit);
        } while (len > 0);
        return Buffer.from(bytes);
      };

      const clientId = `3ahome_srv_${Math.random().toString(16).slice(2, 8)}`;
      const clientIdBuf = Buffer.from(clientId, 'utf8');
      const connectVarHeader = Buffer.from([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c]);
      const connectPayload = Buffer.concat([
        Buffer.from([(clientIdBuf.length >> 8) & 0xff, clientIdBuf.length & 0xff]),
        clientIdBuf
      ]);
      const connectBody = Buffer.concat([connectVarHeader, connectPayload]);
      const connectPacket = Buffer.concat([Buffer.from([0x10]), encodeLength(connectBody.length), connectBody]);

      const topicBuf = Buffer.from(topic, 'utf8');
      const msgBuf = Buffer.from(String(payloadStr), 'utf8');
      const pubBody = Buffer.concat([
        Buffer.from([(topicBuf.length >> 8) & 0xff, topicBuf.length & 0xff]),
        topicBuf,
        msgBuf
      ]);
      const pubPacket = Buffer.concat([Buffer.from([0x30]), encodeLength(pubBody.length), pubBody]);
      const disconnectPacket = Buffer.from([0xe0, 0x00]);

      const flushPublish = () => {
        if (sentPublish) return;
        sentPublish = true;
        try {
          client.write(pubPacket, () => {
            setTimeout(() => {
              try {
                client.write(disconnectPacket, () => client.end());
              } catch {
                client.destroy();
              }
            }, 120);
          });
        } catch {
          client.destroy();
        }
      };

      client.on('data', (chunk) => {
        // Nhận CONNACK (0x20) từ broker rồi gửi gói PUBLISH
        if (chunk && chunk.length >= 2 && chunk[0] === 0x20) {
          flushPublish();
        }
      });

      client.write(connectPacket);
      setTimeout(flushPublish, 600);
    });
    client.on('error', () => client.destroy());
    client.on('timeout', () => client.destroy());
  } catch {
    // ignore external broker error
  }
}

let aedesBrokerRef = null;
function publishMqttCommand(topic, payload, skipExternal = false) {
  const payloadStr = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
  if (aedesBrokerRef) {
    aedesBrokerRef.publish(
      {
        topic,
        payload: Buffer.from(payloadStr, 'utf8'),
        qos: 0,
        retain: false
      },
      () => {}
    );
  }
  if (!skipExternal) {
    const extHost = process.env.EXTERNAL_MQTT_HOST || 'broker.hivemq.com';
    const extPort = Number(process.env.EXTERNAL_MQTT_PORT) || 1883;
    publishToExternalBroker(extHost, extPort, topic, payloadStr);
  }
}

// Đăng ký các tuyến API
app.use('/api', createApiRouter(broadcastWs, publishMqttCommand));

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
aedesBrokerRef = aedesBroker;
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
const defaultCertPath = path.resolve(__dirname, 'certs/fullchain.pem');
const defaultKeyPath = path.resolve(__dirname, 'certs/privkey.pem');
const sslCertPath = process.env.SSL_CERT_PATH || (fs.existsSync(defaultCertPath) ? defaultCertPath : null);
const sslKeyPath = process.env.SSL_KEY_PATH || (fs.existsSync(defaultKeyPath) ? defaultKeyPath : null);

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

async function handleIncomingMqttTelemetry(topic, msgStr, sourceLabel = 'MQTT') {
  console.log(`📩 [${sourceLabel}] Nhận tin - Topic: ${topic} - Data: ${msgStr}`);

  try {
    let data;
    try {
      data = JSON.parse(msgStr);
    } catch {
      const numVal = Number(msgStr);
      if (!Number.isNaN(numVal) && msgStr !== '') {
        data = numVal;
      } else {
        return;
      }
    }

    const { pool: dbPool } = await import('./src/config/db.js');
    const parts = topic.split('/').filter(Boolean);
    const isCmdTopic =
      parts.length >= 5 &&
      parts[0] === '3ahome' &&
      parts[1] === 'telemetry' &&
      parts[3] === 'cmd';
    const cmdChannel = isCmdTopic ? String(parts[4]).toLowerCase() : null;

    let devCode =
      typeof data === 'object' && data !== null
        ? data.device_code || data.deviceId || data.deviceCode
        : null;
    if (!devCode && parts.length > 0) {
      if (isCmdTopic) {
        devCode = parts[2];
      } else if (parts[0] === '3ahome' && parts[1] === 'telemetry' && parts.length >= 3) {
        devCode = parts[2];
      } else {
        devCode = parts[parts.length - 1];
      }
    }

    if (devCode) {
      const formattedDevCode = String(devCode)
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_\-]/g, '');
      if (!formattedDevCode || formattedDevCode.length < 2 || formattedDevCode.length > 50) {
        return;
      }

      const [devRows] = await dbPool.query(
        'SELECT device_id FROM devices WHERE device_code = ?',
        [formattedDevCode]
      );
      let devId;
      if (devRows.length > 0) {
        devId = devRows[0].device_id;
      } else {
        const devName =
          typeof data === 'object' && data !== null && data.device_name
            ? data.device_name
            : `Thiết bị ${formattedDevCode}`;
        const devType =
          typeof data === 'object' && data !== null && data.device_type
            ? data.device_type
            : 'sensor';
        const devFloor =
          typeof data === 'object' && data !== null && data.floor
            ? data.floor
            : 'Khu vực chính';
        const [insDev] = await dbPool.query(
          'INSERT INTO devices (gateway_id, device_code, device_name, device_type, slave_address, floor) VALUES (1, ?, ?, ?, 1, ?)',
          [
            formattedDevCode,
            String(devName).slice(0, 100),
            String(devType).slice(0, 50),
            String(devFloor).slice(0, 50)
          ]
        );
        devId = insDev.insertId;
        console.log(
          `✨ [MQTT Auto-Register] Đã tạo thiết bị mới [${formattedDevCode}] vào bảng devices (device_id: ${devId})!`
        );
      }

      if (devId) {
        let prevShowObj = {};
        let existingMeter = null;
        let existingControl = null;
        let latestRowId = null;
        try {
          const [prevRows] = await dbPool.query(
            'SELECT id, `show`, meter, control FROM telemetry_data WHERE device_id = ? ORDER BY id DESC LIMIT 1',
            [devId]
          );
          if (prevRows.length > 0) {
            latestRowId = prevRows[0].id;
            existingMeter = prevRows[0].meter || null;
            existingControl = prevRows[0].control || null;
            if (prevRows[0].show) {
              prevShowObj =
                typeof prevRows[0].show === 'string'
                  ? JSON.parse(prevRows[0].show)
                  : prevRows[0].show;
            }
          }
        } catch {
          // ignore
        }

        const showObj = isCmdTopic ? { ...(prevShowObj || {}) } : {};
        if (typeof data === 'object' && data !== null) {
          const sourceData =
            data.measurements && typeof data.measurements === 'object'
              ? data.measurements
              : data;
          const ignoredKeys = new Set([
            'device_code',
            'device_id',
            'deviceId',
            'deviceCode',
            'device_name',
            'device_type',
            'floor',
            'measurements'
          ]);
          Object.keys(sourceData || {}).forEach((k) => {
            if (!ignoredKeys.has(k) && sourceData[k] !== undefined) {
              showObj[k] = sourceData[k];
            }
          });
        } else if (cmdChannel) {
          showObj[cmdChannel] = data;
        }

        const rawPayload = {
          device_code: formattedDevCode,
          ...showObj
        };

        const showJsonStr = JSON.stringify(showObj);
        const rawJsonStr = JSON.stringify(rawPayload);

        let recordId = latestRowId;
        if (isCmdTopic && latestRowId) {
          await dbPool.query(
            'UPDATE telemetry_data SET `show` = ?, raw_data = ?, recorded_at = NOW() WHERE id = ?',
            [showJsonStr, rawJsonStr, latestRowId]
          );
        } else {
          const [insRes] = await dbPool.query(
            `
            INSERT INTO telemetry_data (device_id, \`show\`, raw_data, meter, control, recorded_at)
            VALUES (?, ?, ?, ?, ?, NOW())
          `,
            [devId, showJsonStr, rawJsonStr, existingMeter, existingControl]
          );
          recordId = insRes.insertId;
        }

        console.log(
          `✅ [${sourceLabel} -> MySQL] Đã cập nhật cho thiết bị [${formattedDevCode}] (device_id: ${devId}) - show: ${showJsonStr}`
        );
        broadcastWs({
          type: 'TELEMETRY_DATA_SAVED',
          id: recordId || Date.now(),
          device_id: devId,
          device_code: formattedDevCode,
          topic,
          show: showObj,
          raw_data: rawPayload,
          measurements: showObj,
          recorded_at: new Date().toISOString()
        });
      }
    }
  } catch {
    // Bỏ qua nếu tin nhắn không phải JSON/number hợp lệ
  }
}

aedesBroker.on('publish', async (packet, client) => {
  if (client) {
    const topic = packet.topic;
    const msgStr = packet.payload.toString().trim();
    await handleIncomingMqttTelemetry(topic, msgStr, `MQTT:${client.id}`);
  }
});

// Bridge lắng nghe 2 chiều từ MQTT Broker ngoài (broker.hivemq.com:1883) trên topic 3ahome/telemetry/#
function startExternalMqttSubscriberBridge(host, port) {
  let socket = null;
  let pingInterval = null;
  let reconnectTimer = null;

  const encodeLength = (len) => {
    const bytes = [];
    do {
      let digit = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) digit |= 0x80;
      bytes.push(digit);
    } while (len > 0);
    return Buffer.from(bytes);
  };

  const connectBridge = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    try {
      let rxBuffer = Buffer.alloc(0);
      socket = net.createConnection({ host, port }, () => {
        const clientId = `3ahome_bridge_${Math.random().toString(16).slice(2, 10)}`;
        const clientIdBuf = Buffer.from(clientId, 'utf8');
        const connectVarHeader = Buffer.from([
          0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c
        ]);
        const connectPayload = Buffer.concat([
          Buffer.from([(clientIdBuf.length >> 8) & 0xff, clientIdBuf.length & 0xff]),
          clientIdBuf
        ]);
        const connectBody = Buffer.concat([connectVarHeader, connectPayload]);
        const connectPacket = Buffer.concat([
          Buffer.from([0x10]),
          encodeLength(connectBody.length),
          connectBody
        ]);
        socket.write(connectPacket);
      });

      socket.on('data', (chunk) => {
        rxBuffer = Buffer.concat([rxBuffer, chunk]);

        while (rxBuffer.length >= 2) {
          const byte0 = rxBuffer[0];
          const packetType = byte0 & 0xf0;
          let multiplier = 1;
          let remainingLength = 0;
          let offset = 1;
          let encodedByte = 0;

          do {
            if (offset >= rxBuffer.length) {
              return; // Chưa nhận đủ header
            }
            encodedByte = rxBuffer[offset++];
            remainingLength += (encodedByte & 127) * multiplier;
            multiplier *= 128;
          } while ((encodedByte & 128) !== 0);

          const totalPacketLen = offset + remainingLength;
          if (rxBuffer.length < totalPacketLen) {
            return; // Chưa nhận đủ payload của gói tin
          }

          const body = rxBuffer.subarray(offset, totalPacketLen);
          rxBuffer = rxBuffer.subarray(totalPacketLen);

          // CONNACK (0x20) -> Gửi gói SUBSCRIBE '3ahome/telemetry/#'
          if (packetType === 0x20) {
            const topicFilter = '3ahome/telemetry/#';
            const filterBuf = Buffer.from(topicFilter, 'utf8');
            const subBody = Buffer.concat([
              Buffer.from([0x00, 0x01]), // Packet Identifier = 1
              Buffer.from([(filterBuf.length >> 8) & 0xff, filterBuf.length & 0xff]),
              filterBuf,
              Buffer.from([0x00]) // QoS 0
            ]);
            const subPacket = Buffer.concat([
              Buffer.from([0x82]),
              encodeLength(subBody.length),
              subBody
            ]);
            socket.write(subPacket);
            console.log(`🌐 [HiveMQ Bridge] Đã kết nối & Subscribe ${host}:${port} (${topicFilter})`);

            if (pingInterval) clearInterval(pingInterval);
            pingInterval = setInterval(() => {
              if (socket && !socket.destroyed) {
                try {
                  socket.write(Buffer.from([0xc0, 0x00]));
                } catch {}
              }
            }, 25000);
          } else if (packetType === 0x30 && body.length >= 2) {
            // PUBLISH (0x30)
            const topicLen = (body[0] << 8) | body[1];
            if (body.length >= 2 + topicLen) {
              const topic = body.subarray(2, 2 + topicLen).toString('utf8');
              const qos = (byte0 >> 1) & 0x03;
              const payloadStart = 2 + topicLen + (qos > 0 ? 2 : 0);
              if (body.length >= payloadStart) {
                const msgStr = body.subarray(payloadStart).toString('utf8').trim();
                if (msgStr !== '' && !isRecentlySelfPublished(topic, msgStr)) {
                  handleIncomingMqttTelemetry(topic, msgStr, 'HiveMQ');
                }
              }
            }
          }
        }
      });

      const scheduleReconnect = () => {
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(connectBridge, 4000);
        }
      };

      socket.on('close', scheduleReconnect);
      socket.on('error', () => {
        try {
          socket.destroy();
        } catch {}
        scheduleReconnect();
      });
    } catch {
      reconnectTimer = setTimeout(connectBridge, 4000);
    }
  };

  connectBridge();
}

const extBrokerHost = process.env.EXTERNAL_MQTT_HOST || 'broker.hivemq.com';
const extBrokerPort = Number(process.env.EXTERNAL_MQTT_PORT) || 1883;
startExternalMqttSubscriberBridge(extBrokerHost, extBrokerPort);

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
