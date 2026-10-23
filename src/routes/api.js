import express from 'express';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../config/db.js';
import { sendConsultNotificationMail } from '../services/mailService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Hàm tạo tên file ảnh an toàn, triệt tiêu nguy cơ Path Traversal (../) và giới hạn đuôi file ảnh
function generateSafeImageName(prefix = '', rawFileName = '') {
  let ext = '.jpg';
  if (rawFileName && typeof rawFileName === 'string') {
    const rawExt = path.extname(path.basename(rawFileName)).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(rawExt)) {
      ext = rawExt;
    }
  }
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const codeimg = Math.random().toString(36).substring(2, 8).toUpperCase();

  if (prefix === 'proj') {
    const yy = String(yyyy).slice(-2);
    return `proj[${dd}-${mm}-${yy}][${codeimg}]${ext}`;
  }
  if (prefix === 'device') {
    const yy = String(yyyy).slice(-2);
    return `device[${dd}-${mm}-${yy}][${codeimg}]${ext}`;
  }
  return `[${dd}-${mm}-${yyyy}][${codeimg}]${ext}`;
}

export function createApiRouter(broadcastWs) {
  const router = express.Router();

  // 1. Health check endpoint (phục vụ kiểm tra kết nối từ Web / App)
  router.get('/health', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT 1 as test');
      res.json({
        status: 'online',
        database: 'connected',
        serverTime: new Date().toISOString(),
        message: 'AAA_Backend đang hoạt động ổn định trên VPS'
      });
    } catch (err) {
      res.status(500).json({
        status: 'degraded',
        database: 'disconnected',
        error: err.message
      });
    }
  });

  // 2. Lấy danh sách toàn bộ thiết bị
  router.get('/devices', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM devices ORDER BY id ASC');
      // Format lại trường dữ liệu cho khớp với Front-end (camelCase)
      const devices = rows.map((r) => ({
        id: r.id,
        name: r.name,
        clusterId: r.cluster_id,
        roomId: r.room_id,
        type: r.type,
        isOnline: Boolean(r.is_online),
        isOn: Boolean(r.is_on),
        brightness: r.brightness,
        colorValue: r.color_value,
        currentTemp: r.current_temp,
        targetTemp: r.target_temp,
        acMode: r.ac_mode,
        fanSpeed: r.fan_speed,
        humidity: r.humidity,
        powerWatts: r.power_watts,
        mqttTopic: r.mqtt_topic,
        lastUpdated: r.last_updated,
      }));
      res.json(devices);
    } catch (err) {
      res.status(500).json({ error: 'Lỗi truy vấn danh sách thiết bị', details: err.message });
    }
  });

  // 3. Nhận lệnh điều khiển thiết bị từ Web / Mobile App
  router.post('/devices/:id/command', async (req, res) => {
    const { id } = req.params;
    const patch = req.body;

    try {
      // Xây dựng câu truy vấn UPDATE động theo các trường gửi lên
      const updateFields = [];
      const values = [];

      if (patch.isOn !== undefined) {
        updateFields.push('is_on = ?');
        values.push(patch.isOn ? 1 : 0);
      }
      if (patch.brightness !== undefined) {
        updateFields.push('brightness = ?');
        values.push(patch.brightness);
      }
      if (patch.colorValue !== undefined) {
        updateFields.push('color_value = ?');
        values.push(patch.colorValue);
      }
      if (patch.targetTemp !== undefined) {
        updateFields.push('target_temp = ?');
        values.push(patch.targetTemp);
      }
      if (patch.acMode !== undefined) {
        updateFields.push('ac_mode = ?');
        values.push(patch.acMode);
      }
      if (patch.fanSpeed !== undefined) {
        updateFields.push('fan_speed = ?');
        values.push(patch.fanSpeed);
      }

      if (updateFields.length > 0) {
        values.push(id);
        const sql = `UPDATE devices SET ${updateFields.join(', ')} WHERE id = ?`;
        await pool.query(sql, values);

        // Ghi log hoạt động
        const actionDesc = patch.isOn !== undefined ? (patch.isOn ? 'Bật thiết bị' : 'Tắt thiết bị') : 'Cập nhật thông số';
        await pool.query(
          'INSERT INTO activity_logs (source, device_name, message, level) VALUES (?, ?, ?, ?)',
          [patch.source || 'AAA_Client', id, actionDesc, 'info']
        );

        // Bắn WebSocket thông báo cho tất cả Web & Mobile cùng cập nhật ngay lập tức
        if (typeof broadcastWs === 'function') {
          broadcastWs({
            type: 'DEVICE_UPDATED',
            deviceId: id,
            patch,
          });
        }
      }

      res.json({ success: true, message: 'Đã cập nhật trạng thái thiết bị thành công' });
    } catch (err) {
      res.status(500).json({ error: 'Lỗi cập nhật thiết bị', details: err.message });
    }
  });

  // 4. Nhận dữ liệu cảm biến đo lường từ Cụm thiết bị ngoại vi (IoT Telemetry)
  router.post('/telemetry', async (req, res) => {
    const { deviceId, currentTemp, humidity, powerWatts, isOnline } = req.body;
    try {
      await pool.query(
        `UPDATE devices SET 
          current_temp = COALESCE(?, current_temp), 
          humidity = COALESCE(?, humidity), 
          power_watts = COALESCE(?, power_watts),
          is_online = COALESCE(?, is_online)
        WHERE id = ?`,
        [currentTemp, humidity, powerWatts, isOnline !== undefined ? (isOnline ? 1 : 0) : null, deviceId]
      );

      // Bắn WebSocket thông báo số liệu mới
      if (typeof broadcastWs === 'function') {
        broadcastWs({
          type: 'TELEMETRY_UPDATE',
          deviceId,
          data: { currentTemp, humidity, powerWatts, isOnline }
        });
      }

      res.json({ success: true, message: 'Dữ liệu đo đạc đã được ghi nhận' });
    } catch (err) {
      res.status(500).json({ error: 'Lỗi ghi nhận dữ liệu', details: err.message });
    }
  });

  // 5. Lấy danh sách Logs hoạt động
  router.get('/logs', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM activity_logs ORDER BY id DESC LIMIT 50');
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: 'Lỗi lấy nhật ký hoạt động', details: err.message });
    }
  });

  // 6. Quản lý người dùng phòng mô phỏng 3D (Bảng simu trong database 3ahome)
  router.get('/simu', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM simu ORDER BY id DESC');
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Lỗi truy vấn bảng simu' });
    }
  });

  router.post('/simu', async (req, res) => {
    const { full_name, email, phone } = req.body;
    if (!full_name || !email || !phone) {
      return res.status(400).json({ error: 'Vui lòng điền đầy đủ thông tin' });
    }

    try {
      const cleanName = full_name.trim();
      const cleanEmail = email.trim();
      const cleanPhone = phone.trim();

      const [existingRows] = await pool.query(
        'SELECT * FROM simu WHERE full_name = ? AND email = ? AND phone = ? LIMIT 1',
        [cleanName, cleanEmail, cleanPhone]
      );

      if (existingRows.length > 0) {
        const existing = existingRows[0];
        await pool.query('UPDATE simu SET count = count + 1, time = NOW() WHERE id = ?', [existing.id]);
        const [updatedRows] = await pool.query('SELECT * FROM simu WHERE id = ?', [existing.id]);
        return res.json({
          success: true,
          isReturning: true,
          message: 'Chào mừng bạn quay trở lại',
          record: updatedRows[0],
        });
      } else {
        const [insertRes] = await pool.query(
          'INSERT INTO simu (time, full_name, email, phone, count) VALUES (NOW(), ?, ?, ?, 1)',
          [cleanName, cleanEmail, cleanPhone]
        );
        const [newRows] = await pool.query('SELECT * FROM simu WHERE id = ?', [insertRes.insertId]);
        return res.json({
          success: true,
          isReturning: false,
          message: 'Đăng ký phòng mô phỏng thành công',
          record: newRows[0],
        });
      }
    } catch (err) {
      res.status(500).json({ error: err.message || 'Lỗi lưu thông tin simu' });
    }
  });

  // 7. Xác thực đăng nhập từ bảng login (Phân quyền: authen = 1 -> Dash, authen = 2 -> Employ)
  router.post('/login', async (req, res) => {
    const { gmail, password } = req.body;
    if (!gmail || !password) {
      return res.status(400).json({ success: false, message: 'Vui lòng điền đầy đủ Gmail và Mật khẩu.' });
    }

    try {
      const [rows] = await pool.query(
        'SELECT id, time, full_name, room, position, gmail, password, phone, authen, state FROM login WHERE gmail = ? LIMIT 1',
        [gmail.trim()]
      );

      if (rows.length === 0) {
        // Kiểm tra tài khoản khách hàng trong bảng locations (customer_email & customer_pass)
        const [locRows] = await pool.query(
          'SELECT location_id, location_name, address, customer_name, customer_phone, customer_email, customer_pass, status FROM locations WHERE customer_email = ? LIMIT 1',
          [gmail.trim()]
        );
        if (locRows.length > 0) {
          const loc = locRows[0];
          const validPass = loc.customer_pass || '3AH@me';
          if (validPass === password) {
            return res.json({
              success: true,
              role: 'customer',
              message: 'Đăng nhập khách hàng thành công',
              user: {
                id: loc.location_id,
                full_name: loc.customer_name || loc.location_name,
                gmail: loc.customer_email,
                phone: loc.customer_phone,
                role: 'customer',
                projectName: loc.location_name,
                address: loc.address,
                status: loc.status
              }
            });
          }
        }
        return res.status(401).json({ success: false, message: 'Gmail hoặc Mật khẩu không chính xác.' });
      }

      const user = rows[0];
      if (user.state && user.state.toLowerCase() === 'inactive') {
        return res.status(403).json({ success: false, message: 'Tài khoản của bạn đang bị khóa.' });
      }

      let isMatch = false;
      if (user.password && (user.password.startsWith('$2a$') || user.password.startsWith('$2b$'))) {
        isMatch = await bcrypt.compare(password, user.password);
      } else {
        isMatch = (password === user.password);
        if (isMatch) {
          // Tự động nâng cấp mã hoá sang bcrypt
          const upgradedHash = await bcrypt.hash(password, 10);
          await pool.query('UPDATE login SET password = ? WHERE id = ?', [upgradedHash, user.id]);
        }
      }

      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Gmail hoặc Mật khẩu không chính xác.' });
      }

      // Cập nhật trạng thái và ghi log đăng nhập vào user_activity_logs
      try {
        await pool.query('UPDATE login SET last_online = NOW() WHERE id = ?', [user.id]);
        await pool.query(
          'INSERT INTO user_activity_logs (login_id, action_type, module, created_at) VALUES (?, "LOGIN", "overview", NOW())',
          [user.id]
        );
      } catch {
        // ignore log error
      }

      return res.json({
        success: true,
        message: 'Đăng nhập thành công',
        user: {
          id: user.id,
          full_name: user.full_name,
          room: user.room,
          position: user.position,
          gmail: user.gmail,
          phone: user.phone,
          authen: Number(user.authen),
          state: user.state
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi máy chủ cơ sở dữ liệu' });
    }
  });

  // 7.1. API Đăng nhập Khách hàng qua customer_email & customer_pass trong bảng locations
  router.post('/customer-login', async (req, res) => {
    const { email, password, gmail } = req.body;
    const inputEmail = (email || gmail || '').trim();
    const inputPass = (password || '').trim();

    if (!inputEmail || !inputPass) {
      return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ Email và Mật khẩu.' });
    }

    try {
      await ensureIotTables();
      const [rows] = await pool.query(
        'SELECT location_id, location_name, address, customer_name, customer_phone, customer_email, customer_pass, status, created_at FROM locations WHERE customer_email = ? LIMIT 1',
        [inputEmail]
      );

      if (rows.length === 0) {
        return res.status(401).json({ success: false, message: 'Email khách hàng không tồn tại trong hệ thống.' });
      }

      const loc = rows[0];
      const validPass = loc.customer_pass || '3AH@me';

      if (validPass !== inputPass) {
        return res.status(401).json({ success: false, message: 'Mật khẩu khách hàng không chính xác.' });
      }

      // Lấy thông tin gateway và devices liên kết với location này
      const [gws] = await pool.query(
        'SELECT gateway_id, gateway_sn, ip_address, status, last_seen FROM gateways WHERE location_id = ? LIMIT 1',
        [loc.location_id]
      );
      const gateway = gws.length > 0 ? gws[0] : null;

      let devices = [];
      if (gateway) {
        const [devs] = await pool.query(
          'SELECT device_id, device_code, device_name, device_type, slave_address, floor FROM devices WHERE gateway_id = ? ORDER BY slave_address ASC',
          [gateway.gateway_id]
        );
        devices = devs;
      }

      return res.json({
        success: true,
        message: 'Đăng nhập khách hàng thành công',
        role: 'customer',
        data: {
          location_id: loc.location_id,
          location_name: loc.location_name,
          customer_name: loc.customer_name || loc.location_name,
          customer_email: loc.customer_email,
          customer_phone: loc.customer_phone,
          customer_pass: loc.customer_pass || '3AH@me',
          address: loc.address,
          status: loc.status,
          gateway: gateway,
          devices: devices
        }
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message || 'Lỗi xử lý đăng nhập' });
    }
  });

  // 8. Lấy toàn bộ danh sách tài khoản từ bảng login
  router.get('/login', async (req, res) => {
    try {
      // Bảo mật: Không bao giờ trả về trường mật khẩu/hash ra API
      const [rows] = await pool.query(
        'SELECT id, time, full_name, room, position, gmail, phone, authen, state FROM login ORDER BY id ASC'
      );
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi truy vấn danh sách tài khoản' });
    }
  });

  // 9. Cập nhật tài khoản trong bảng login
  router.put('/login/:id', async (req, res) => {
    const { id } = req.params;
    const { full_name, room, position, gmail, password, phone, authen, state } = req.body;
    try {
      if (password && password.trim()) {
        let hashedPassword = password.trim();
        if (!hashedPassword.startsWith('$2a$') && !hashedPassword.startsWith('$2b$')) {
          hashedPassword = await bcrypt.hash(hashedPassword, 10);
        }
        await pool.query(
          'UPDATE login SET full_name = ?, room = ?, position = ?, gmail = ?, password = ?, phone = ?, authen = ?, state = ? WHERE id = ?',
          [full_name, room, position, gmail, hashedPassword, phone, authen, state, id]
        );
      } else {
        await pool.query(
          'UPDATE login SET full_name = ?, room = ?, position = ?, gmail = ?, phone = ?, authen = ?, state = ? WHERE id = ?',
          [full_name, room, position, gmail, phone, authen, state, id]
        );
      }
      res.json({ success: true, message: 'Đã cập nhật tài khoản thành công' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi cập nhật tài khoản' });
    }
  });

  // 10. Xóa tài khoản trong bảng login
  router.delete('/login/:id', async (req, res) => {
    const { id } = req.params;
    try {
      await pool.query('DELETE FROM login WHERE id = ?', [id]);
      res.json({ success: true, message: 'Đã xóa tài khoản thành công' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi xóa tài khoản' });
    }
  });

  // 11. Thêm tài khoản mới vào bảng login
  router.post('/login/create', async (req, res) => {
    const { full_name, room, position, gmail, password, phone, authen, state } = req.body;
    if (!full_name || !gmail || !password) {
      return res.status(400).json({ success: false, message: 'Vui lòng điền Họ tên, Gmail và Mật khẩu.' });
    }
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const [insertRes] = await pool.query(
        'INSERT INTO login (time, full_name, room, position, gmail, password, phone, authen, state) VALUES (NOW(), ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          full_name.trim(),
          room?.trim() || null,
          position?.trim() || null,
          gmail.trim(),
          hashedPassword,
          phone?.trim() || null,
          Number(authen) || 2,
          state || 'active'
        ]
      );
      const [newRows] = await pool.query(
        'SELECT id, time, full_name, room, position, gmail, password, phone, authen, state FROM login WHERE id = ?',
        [insertRes.insertId]
      );
      res.json({ success: true, message: 'Thêm tài khoản thành công', record: newRows[0] });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi thêm tài khoản' });
    }
  });

  // 12. Reset mật khẩu tài khoản trong bảng login
  router.post('/login/reset-password', async (req, res) => {
    const { id, password } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, message: 'Thiếu ID tài khoản' });
    }
    const newPassword = password || '3AHome@2026';
    try {
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await pool.query('UPDATE login SET password = ? WHERE id = ?', [hashedPassword, id]);
      res.json({ success: true, message: `Đã đặt lại mật khẩu về "${newPassword}" thành công!` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi reset mật khẩu' });
    }
  });

  // 12.1. Ghi nhận hoạt động đăng nhập, ping online và truy cập danh mục
  router.post('/track-activity', async (req, res) => {
    const { loginId, gmail, actionType = 'PING', module = 'overview' } = req.body || {};
    if (!loginId && !gmail) {
      return res.status(400).json({ success: false, message: 'Thiếu loginId hoặc gmail' });
    }

    try {
      let targetId = loginId;
      if (!targetId && gmail) {
        const [rows] = await pool.query('SELECT id FROM login WHERE gmail = ? LIMIT 1', [gmail.trim()]);
        if (rows.length > 0) targetId = rows[0].id;
      }

      if (targetId) {
        // Cập nhật thời điểm online gần nhất trong bảng login
        await pool.query('UPDATE login SET last_online = NOW() WHERE id = ?', [targetId]);

        // Ghi log hoạt động
        await pool.query(
          'INSERT INTO user_activity_logs (login_id, action_type, module, created_at) VALUES (?, ?, ?, NOW())',
          [targetId, actionType, module]
        );
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi ghi nhận hoạt động' });
    }
  });

  // 12.2. Thống kê toàn diện hoạt động nhân sự (Online thời gian thực, lượt online ngày/tuần/tháng/năm, và mốc thời gian vào 7 danh mục dưới dạng JSON)
  router.get('/user-stats', async (req, res) => {
    try {
      // Đảm bảo bảng user_activity_logs tồn tại
      await pool.query(`
        CREATE TABLE IF NOT EXISTS user_activity_logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          login_id INT NOT NULL,
          action_type VARCHAR(50) NOT NULL,
          module VARCHAR(50) NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_login_act (login_id, action_type, module, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // Lấy danh sách tài khoản kèm tính toán trạng thái Online trực tiếp bằng TIMESTAMPDIFF của MySQL
      const [users] = await pool.query(`
        SELECT id, time, full_name, room, position, gmail, phone, authen, state, last_online,
               CASE
                 WHEN last_online IS NOT NULL AND TIMESTAMPDIFF(SECOND, last_online, NOW()) <= 300 THEN 1
                 ELSE 0
               END AS is_online_db
        FROM login
        ORDER BY id ASC
      `);

      // Lấy nhật ký hoạt động
      const [logs] = await pool.query(`
        SELECT login_id, action_type, module, created_at
        FROM user_activity_logs
        ORDER BY created_at DESC
      `);

      const now = new Date();

      const MODULE_KEYS = [
        { key: 'overview', name: 'Tổng quan' },
        { key: 'projects', name: 'Dự án triển khai' },
        { key: 'news', name: 'Tin tức truyền thông' },
        { key: 'supplies', name: 'Vật tư thiết bị' },
        { key: 'customers', name: 'Khách hàng' },
        { key: 'finance', name: 'Tài chính kế toán' },
        { key: 'tasks', name: 'Quản lý công việc' }
      ];

      const stats = users.map((u) => {
        const userLogs = logs.filter((l) => Number(l.login_id) === Number(u.id));

        // Kiểm tra trạng thái Online chính xác theo MySQL
        const isOnline = Boolean(Number(u.is_online_db) === 1);

        // Lọc các log phiên đăng nhập / hoạt động (LOGIN)
        const loginLogs = userLogs.filter((l) => l.action_type === 'LOGIN');

        const todayCount = loginLogs.filter((l) => {
          const d = new Date(l.created_at);
          return d.toDateString() === now.toDateString();
        }).length;

        // Tính ngày đầu tuần (Thứ 2)
        const startOfWeek = new Date(now);
        const day = startOfWeek.getDay() || 7;
        startOfWeek.setDate(startOfWeek.getDate() - day + 1);
        startOfWeek.setHours(0, 0, 0, 0);

        const weekCount = loginLogs.filter((l) => new Date(l.created_at) >= startOfWeek).length;

        const monthCount = loginLogs.filter((l) => {
          const d = new Date(l.created_at);
          return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
        }).length;

        const yearCount = loginLogs.filter((l) => {
          const d = new Date(l.created_at);
          return d.getFullYear() === now.getFullYear();
        }).length;

        // Thống kê 7 danh mục
        const modulesData = {};
        let totalModuleVisits = 0;

        MODULE_KEYS.forEach(({ key, name }) => {
          const modLogs = userLogs.filter((l) => l.action_type === 'VISIT_PAGE' && l.module === key);
          const count = modLogs.length;
          totalModuleVisits += count;

          const timestamps = modLogs.map((l) => {
            const d = new Date(l.created_at);
            if (!isNaN(d.getTime())) {
              const hh = String(d.getHours()).padStart(2, '0');
              const mm = String(d.getMinutes()).padStart(2, '0');
              const ss = String(d.getSeconds()).padStart(2, '0');
              const dd = String(d.getDate()).padStart(2, '0');
              const MM = String(d.getMonth() + 1).padStart(2, '0');
              const yyyy = d.getFullYear();
              return `${hh}:${mm}:${ss} ${dd}/${MM}/${yyyy}`;
            }
            return String(l.created_at);
          });

          modulesData[key] = {
            module_name: name,
            count,
            last_visited: timestamps.length > 0 ? timestamps[0] : null,
            timestamps: timestamps.slice(0, 20) // Lưu 20 mốc thời gian gần nhất
          };
        });

        const detailJson = {
          user_id: u.id,
          full_name: u.full_name,
          gmail: u.gmail,
          room: u.room || 'Chưa cập nhật',
          position: u.position || 'Nhân viên',
          role: Number(u.authen) === 1 ? 'Quản trị viên' : 'Nhân sự',
          is_online: isOnline,
          last_online: u.last_online ? new Date(u.last_online).toISOString().replace('T', ' ').substring(0, 19) : null,
          online_statistics: {
            today: Math.max(todayCount, isOnline ? 1 : 0),
            this_week: Math.max(weekCount, isOnline ? 1 : 0),
            this_month: Math.max(monthCount, isOnline ? 1 : 0),
            this_year: Math.max(yearCount, isOnline ? 1 : 0)
          },
          total_module_visits: totalModuleVisits,
          modules: modulesData
        };

        return {
          ...u,
          is_online: isOnline,
          online_stats: detailJson.online_statistics,
          modules: modulesData,
          total_module_visits: totalModuleVisits,
          raw_json: detailJson
        };
      });

      res.json({
        success: true,
        data: stats,
        summary: {
          total_users: users.length,
          online_now: stats.filter((s) => s.is_online).length
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi truy vấn thống kê hoạt động nhân sự' });
    }
  });

  // 13. Thu thập và thống kê lượng truy cập thực tế (Bảng site_visits trong 3ahome)
  router.post('/visit', async (req, res) => {
    const { sessionId } = req.body || {};
    const cleanSessionId = (sessionId && String(sessionId).trim()) || 'anonymous_session';
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS site_visits (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          session_id VARCHAR(100) NOT NULL,
          ip_address VARCHAR(100) DEFAULT NULL,
          user_agent TEXT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_active DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_session (session_id),
          INDEX idx_created (created_at),
          INDEX idx_active (last_active)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      const [existing] = await pool.query(
        'SELECT id FROM site_visits WHERE session_id = ? AND DATE(created_at) = CURDATE() LIMIT 1',
        [cleanSessionId]
      );

      if (existing.length > 0) {
        await pool.query('UPDATE site_visits SET last_active = NOW() WHERE id = ?', [existing[0].id]);
      } else {
        await pool.query(
          'INSERT INTO site_visits (session_id, ip_address, user_agent, created_at, last_active) VALUES (?, ?, ?, NOW(), NOW())',
          [cleanSessionId, clientIp, userAgent]
        );
      }

      const [statsRows] = await pool.query(`
        SELECT
          (SELECT COUNT(DISTINCT session_id) FROM site_visits WHERE last_active >= NOW() - INTERVAL 5 MINUTE) AS online,
          (SELECT COUNT(DISTINCT session_id) FROM site_visits WHERE DATE(created_at) = CURDATE()) AS today,
          (SELECT COUNT(DISTINCT session_id) FROM site_visits WHERE YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())) AS month,
          (SELECT COUNT(DISTINCT session_id) FROM site_visits WHERE YEAR(created_at) = YEAR(CURDATE())) AS year,
          (SELECT COUNT(DISTINCT session_id) FROM site_visits) AS total,
          (SELECT COALESCE(SUM(count), 0) FROM simu) AS simu_visits,
          (SELECT COUNT(*) FROM simu) AS simu_users
      `);

      const row = statsRows[0] || {};
      res.json({
        success: true,
        stats: {
          online: Math.max(1, Number(row.online || 1)),
          today: Number(row.today || 1),
          month: Number(row.month || 1),
          year: Number(row.year || 1),
          total: Number(row.total || 1),
          simu: Number(row.simu_visits || row.simu_users || 0),
          simuUsers: Number(row.simu_users || 0)
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi xử lý thống kê truy cập' });
    }
  });

  router.get('/visit', async (req, res) => {
    try {
      const [statsRows] = await pool.query(`
        SELECT
          (SELECT COUNT(DISTINCT session_id) FROM site_visits WHERE last_active >= NOW() - INTERVAL 5 MINUTE) AS online,
          (SELECT COUNT(DISTINCT session_id) FROM site_visits WHERE DATE(created_at) = CURDATE()) AS today,
          (SELECT COUNT(DISTINCT session_id) FROM site_visits WHERE YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())) AS month,
          (SELECT COUNT(DISTINCT session_id) FROM site_visits WHERE YEAR(created_at) = YEAR(CURDATE())) AS year,
          (SELECT COUNT(DISTINCT session_id) FROM site_visits) AS total,
          (SELECT COALESCE(SUM(count), 0) FROM simu) AS simu_visits,
          (SELECT COUNT(*) FROM simu) AS simu_users
      `);
      const row = statsRows[0] || {};
      res.json({
        success: true,
        stats: {
          online: Math.max(1, Number(row.online || 1)),
          today: Number(row.today || 1),
          month: Number(row.month || 1),
          year: Number(row.year || 1),
          total: Number(row.total || 1),
          simu: Number(row.simu_visits || row.simu_users || 0),
          simuUsers: Number(row.simu_users || 0)
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi lấy thống kê truy cập' });
    }
  });

  // 14. Tiếp nhận đăng ký tư vấn miễn phí từ trang chủ (Bảng consult trong database 3ahome)
  router.post('/consult', async (req, res) => {
    const { full_name, email, phone, type, content, notify_emails } = req.body || {};
    if (!full_name || !email || !phone) {
      return res.status(400).json({ success: false, message: 'Vui lòng điền đầy đủ Họ và tên, Email và Số điện thoại.' });
    }

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS consult (
          id INT AUTO_INCREMENT PRIMARY KEY,
          time DATETIME DEFAULT CURRENT_TIMESTAMP,
          full_name VARCHAR(255) NOT NULL,
          email VARCHAR(255) NOT NULL,
          phone VARCHAR(50) NOT NULL,
          type VARCHAR(100) NOT NULL,
          content TEXT DEFAULT NULL,
          status INT NOT NULL DEFAULT 1
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      const [result] = await pool.query(
        'INSERT INTO consult (time, full_name, email, phone, type, content, status) VALUES (NOW(), ?, ?, ?, ?, ?, 1)',
        [full_name.trim(), email.trim(), phone.trim(), (type || 'Tư vấn giải pháp').trim(), content ? content.trim() : null]
      );

      console.log(`[CONSULT] Nhận yêu cầu tư vấn mới từ ${full_name} (${phone}) - Loại: ${type || 'Tư vấn giải pháp'}.`);

      // Tự động gửi email thông báo trực tiếp qua Gmail SMTP tới 3ahomeadmin@gmail.com và CC son.lm@3ahome.vn
      sendConsultNotificationMail({
        full_name: full_name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        type: (type || 'Tư vấn giải pháp').trim(),
        content: content ? content.trim() : '',
        source: (req.headers['user-agent'] && req.headers['user-agent'].includes('Dart')) ? 'Ứng dụng Smart IOT (Mobile)' : 'Website 3AHOME (https://3ahome.vn)'
      }).catch(err => console.error('[CONSULT] Lỗi gửi email nền:', err));

      res.json({
        success: true,
        message: 'Gửi yêu cầu tư vấn thành công',
        id: result.insertId
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi lưu thông tin tư vấn' });
    }
  });

  router.get('/consult', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM consult ORDER BY id DESC');
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi truy vấn bảng consult' });
    }
  });

  // 15. Quản lý bảng tin tức (news)
  // Lấy danh sách tin tức
  router.get('/news', async (req, res) => {
    try {
      // Đảm bảo bảng news đã tồn tại
      await pool.query(`
        CREATE TABLE IF NOT EXISTS news (
          id INT AUTO_INCREMENT PRIMARY KEY,
          time DATETIME DEFAULT CURRENT_TIMESTAMP,
          topic VARCHAR(100) NOT NULL,
          title VARCHAR(255) NOT NULL,
          content TEXT NOT NULL,
          image VARCHAR(255) DEFAULT NULL,
          author VARCHAR(255) NOT NULL,
          status INT NOT NULL DEFAULT 1
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      let [rows] = await pool.query('SELECT * FROM news ORDER BY id DESC');
      if (rows.length === 0) {
        const seedNews = [
          [
            'Xu hướng công nghệ',
            'Tối ưu hoá năng lượng toà nhà thông minh với giải pháp AI & BMS thế hệ mới',
            'Ứng dụng thuật toán máy học phân tích hành vi tiêu thụ nhiệt và điện thời gian thực, giúp cắt giảm đến 35% chi phí năng lượng vận hành hệ thống Chiller và chiếu sáng toà nhà cao tầng.',
            'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1000&q=80',
            'Quản trị viên',
            1
          ],
          [
            'Hợp tác chiến lược',
            '3AHOME ký kết hợp tác chiến lược cung ứng thiết bị BACnet IP chuẩn quốc tế',
            'Mở rộng mạng lưới phân phối thiết bị điều khiển lập trình DDC và cảm biến chuyên dụng cho các đại dự án cao ốc tại Việt Nam.',
            'https://images.unsplash.com/photo-1577495508048-b635879837f1?auto=format&fit=crop&w=600&q=80',
            'Ban giám đốc',
            1
          ],
          [
            'Giải pháp kỹ thuật',
            'Tiêu chuẩn điều áp buồng thang và an toàn PCCC liên động trong nhà cao tầng',
            'Hướng dẫn giải pháp tích hợp cảm biến khói ống gió và van hút khói hành lang theo quy chuẩn an toàn PCCC mới nhất.',
            'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=600&q=80',
            'Phòng kỹ thuật',
            1
          ],
          [
            'Hội thảo & Sự kiện',
            'Hội thảo chuyên đề: Chuyển đổi số trong quản lý vận hành toà nhà xanh LEED',
            'Chia sẻ kinh nghiệm thực tiễn từ các chuyên gia hàng đầu về ứng dụng chuẩn giao tiếp mở BACnet MS/TP và Modbus RTU.',
            'https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?auto=format&fit=crop&w=600&q=80',
            'Ban truyền thông',
            1
          ],
          [
            'Công nghệ mới',
            'Ứng dụng IoT & AI trong bảo trì dự đoán hệ thống bơm cấp thoát nước và Chiller',
            'Giảm thiểu 45% thời gian ngừng trệ kỹ thuật nhờ giám sát độ rung, nhiệt độ động cơ và cảnh báo hỏng hóc sớm.',
            'https://images.unsplash.com/photo-1581092160607-ee22621dd758?auto=format&fit=crop&w=600&q=80',
            'Kỹ sư R&D',
            1
          ]
        ];

        for (const n of seedNews) {
          await pool.query(
            'INSERT INTO news (time, topic, title, content, image, author, status) VALUES (NOW(), ?, ?, ?, ?, ?, ?)',
            n
          );
        }
        const [seededRows] = await pool.query('SELECT * FROM news ORDER BY id DESC');
        rows = seededRows;
      }
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi truy vấn bảng news' });
    }
  });

  // Tạo bài đăng mới
  router.post('/news', async (req, res) => {
    const { topic, title, content, author, imageBase64, imageFileName } = req.body || {};
    if (!topic || !title || !content) {
      return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ Chủ đề, Tiêu đề và Nội dung.' });
    }

    try {
      let imageDbPath = '';
      if (imageBase64 && typeof imageBase64 === 'string') {
        // Tên file an toàn: [dd-mm-yyyy][codeimg]
        const filename = generateSafeImageName('', imageFileName);
        const uploadsDir = path.resolve(__dirname, '../../uploads/news');
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }

        const filePath = path.join(uploadsDir, filename);
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        await fs.promises.writeFile(filePath, Buffer.from(base64Data, 'base64'));

        // Cột image lưu đường dẫn dạng \AAA_Backend\uploads\news\[dd-mm-yyyy][codeimg]
        imageDbPath = `\\AAA_Backend\\uploads\\news\\${filename}`;
      }

      const [result] = await pool.query(
        'INSERT INTO news (time, topic, title, content, image, author, status) VALUES (NOW(), ?, ?, ?, ?, ?, 1)',
        [
          topic.trim(),
          title.trim(),
          content.trim(),
          imageDbPath || null,
          (author || 'Quản trị viên').trim()
        ]
      );

      res.json({
        success: true,
        message: 'Tạo bài đăng thành công',
        id: result.insertId,
        image: imageDbPath
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi lưu bài đăng' });
    }
  });

  // Cập nhật nội dung bài đăng (bao gồm cả thay thế hình ảnh nếu có)
  router.put('/news/:id', async (req, res) => {
    const { id } = req.params;
    const { topic, title, content, author, status, imageBase64, imageFileName } = req.body || {};

    try {
      let imageDbPath = undefined;
      if (imageBase64 && typeof imageBase64 === 'string' && imageBase64.startsWith('data:image')) {
        const filename = generateSafeImageName('', imageFileName);
        const uploadsDir = path.resolve(__dirname, '../../uploads/news');
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }

        const filePath = path.join(uploadsDir, filename);
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        await fs.promises.writeFile(filePath, Buffer.from(base64Data, 'base64'));

        imageDbPath = `\\AAA_Backend\\uploads\\news\\${filename}`;
      }

      if (imageDbPath !== undefined) {
        await pool.query(
          'UPDATE news SET topic = ?, title = ?, content = ?, author = ?, status = ?, image = ? WHERE id = ?',
          [
            (topic || '').trim(),
            (title || '').trim(),
            (content || '').trim(),
            (author || 'Quản trị viên').trim(),
            Number(status) || 1,
            imageDbPath,
            id
          ]
        );
      } else {
        await pool.query(
          'UPDATE news SET topic = ?, title = ?, content = ?, author = ?, status = ? WHERE id = ?',
          [
            (topic || '').trim(),
            (title || '').trim(),
            (content || '').trim(),
            (author || 'Quản trị viên').trim(),
            Number(status) || 1,
            id
          ]
        );
      }
      res.json({ success: true, message: 'Cập nhật bài đăng thành công' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi cập nhật bài đăng' });
    }
  });

  // Cập nhật trạng thái bài viết (status = 1: trình duyệt, 2: đăng bài, 3: đang ẩn)
  router.patch('/news/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body || {};
    try {
      await pool.query('UPDATE news SET status = ? WHERE id = ?', [Number(status) || 1, id]);
      res.json({ success: true, message: 'Đã cập nhật trạng thái bài viết' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi cập nhật trạng thái bài viết' });
    }
  });

  // Ẩn bài đăng (cột status = 3)
  router.patch('/news/:id/hide', async (req, res) => {
    const { id } = req.params;
    try {
      await pool.query('UPDATE news SET status = 3 WHERE id = ?', [id]);
      res.json({ success: true, message: 'Đã ẩn bài đăng thành công' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi ẩn bài đăng' });
    }
  });

  // Xoá bài đăng và file hình ảnh tương ứng
  router.delete('/news/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const [rows] = await pool.query('SELECT image FROM news WHERE id = ?', [id]);
      if (rows && rows.length > 0 && rows[0].image) {
        const imgPath = rows[0].image;
        const filename = path.basename(imgPath);
        const physicalPath = path.resolve(__dirname, '../../uploads/news', filename);
        if (fs.existsSync(physicalPath)) {
          try {
            await fs.promises.unlink(physicalPath);
          } catch {
            // ignore unlink error
          }
        }
      }

      await pool.query('DELETE FROM news WHERE id = ?', [id]);
      res.json({ success: true, message: 'Đã xoá bài đăng và hình ảnh thành công' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi xoá bài đăng' });
    }
  });

  // 16. Quản lý bảng dự án (project)
  // Lấy danh sách dự án
  router.get('/projects', async (req, res) => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS project (
          id INT AUTO_INCREMENT PRIMARY KEY,
          time DATETIME DEFAULT CURRENT_TIMESTAMP,
          type VARCHAR(255) NOT NULL,
          title VARCHAR(500) NOT NULL,
          content TEXT NOT NULL,
          place VARCHAR(255) NOT NULL,
          year VARCHAR(50) DEFAULT NULL,
          start VARCHAR(50) DEFAULT NULL,
          image VARCHAR(500) DEFAULT NULL,
          status INT NOT NULL DEFAULT 1
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      let [rows] = await pool.query('SELECT * FROM project ORDER BY id DESC');
      if (rows.length === 0) {
        const seedProjects = [
          [
            'Khu biệt thự cao cấp & Smart Villa',
            'Dự án khu biệt thự sinh thái Danang Pearl - Ngũ Hành Sơn, Đà Nẵng',
            'Triển khai giải pháp Smart Home toàn diện cho quần thể biệt thự sinh thái Danang Pearl: điều khiển chiếu sáng thông minh, điều hoà trung tâm VRV, quản lý năng lượng và an ninh đa lớp.',
            'Đà Nẵng',
            '2023 - 2024',
            '2023 - 2024',
            '/AAA_Backend/uploads/project/proj[25-09-24][DANANG1].webp',
            1
          ],
          [
            'Cao ốc thương mại & Nhà máy',
            'Nhà máy Kim Long Motor Huế',
            'Cung cấp và lắp đặt hệ thống BMS cho nhà máy sản xuất ô tô Kim Long Motor.',
            'Huế',
            '2025',
            '2025',
            '/AAA_Backend/uploads/project/proj[25-09-24][KIMLONG2].webp',
            1
          ],
          [
            'Trung tâm phức hợp',
            'Trung tâm sinh học thành phố Đà Nẵng',
            'Cung cấp và lắp đặt hệ thống BMS cho Trung tâm sinh học Đà Nẵng.',
            'Đà Nẵng',
            '2025',
            '2025',
            '/AAA_Backend/uploads/project/proj[25-09-24][SINHHOC3].webp',
            1
          ],
          [
            'Văn phòng LEED Platinum',
            'Công viên phát triển phần mềm số 2 Đà Nẵng',
            'Cung cấp và lắp đặt hệ thống BMS cho Danang Software Park 2.',
            'Đà Nẵng',
            '2024 - 2025',
            '2024 - 2025',
            '/AAA_Backend/uploads/project/proj[25-09-24][DSPARK4].webp',
            1
          ],
          [
            'Nhà máy & Phòng sạch',
            'Nhà máy Thạch Anh - Huế',
            'Cung cấp thiết bị và lập trình hệ thống quản lý toà nhà BMS.',
            'Huế',
            '2023',
            '2023',
            '/AAA_Backend/uploads/project/proj[25-09-24][THANH5].webp',
            1
          ],
          [
            'Cao ốc biểu tượng',
            'Toà tháp Landmark 81 - Vinhomes Central Park',
            'Cung cấp và tích hợp cảm biến áp suất gió, nước chuyên dụng cùng hệ thống van điều khiển HVAC tải lạnh lớn tầng cao.',
            'Bình Thạnh, TP. Hồ Chí Minh',
            '2022 - 2023',
            '2022 - 2023',
            '/AAA_Backend/uploads/project/proj[25-09-24][LMARK6].webp',
            1
          ]
        ];

        for (const p of seedProjects) {
          await pool.query(
            'INSERT INTO project (type, title, content, place, year, start, image, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            p
          );
        }
        const [seededRows] = await pool.query('SELECT * FROM project ORDER BY id DESC');
        rows = seededRows;
      }
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi truy vấn bảng project' });
    }
  });

  // Tạo dự án mới
  router.post('/projects', async (req, res) => {
    const { type, title, content, place, start, year, imageBase64, imageFileName } = req.body || {};
    if (!type || !title || !content || !place) {
      return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ các trường thông tin dự án.' });
    }

    const projectYear = (start || year || new Date().getFullYear().toString()).trim();

    try {
      let imageDbPath = '';
      if (imageBase64 && typeof imageBase64 === 'string') {
        const filename = generateSafeImageName('proj', imageFileName);
        const uploadsDir = path.resolve(__dirname, '../../uploads/project');
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }

        const filePath = path.join(uploadsDir, filename);
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        await fs.promises.writeFile(filePath, Buffer.from(base64Data, 'base64'));

        // Cột image lưu đường dẫn của hình ảnh proj[dd-mm-yy][codeimg] trong /AAA_Backend/uploads/project
        imageDbPath = `/AAA_Backend/uploads/project/${filename}`;
      }

      const [result] = await pool.query(
        'INSERT INTO project (time, type, title, content, place, year, start, image, status) VALUES (NOW(), ?, ?, ?, ?, ?, ?, ?, 1)',
        [
          type.trim(),
          title.trim(),
          content.trim(),
          place.trim(),
          projectYear,
          projectYear,
          imageDbPath || null
        ]
      );

      res.json({
        success: true,
        message: 'Tạo dự án mới thành công',
        id: result.insertId,
        image: imageDbPath
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi lưu dự án' });
    }
  });

  // Cập nhật thông tin dự án
  router.put('/projects/:id', async (req, res) => {
    const { id } = req.params;
    const { type, title, content, place, start, year, status } = req.body || {};
    const projectYear = (start || year || '').trim();

    try {
      await pool.query(
        'UPDATE project SET type = ?, title = ?, content = ?, place = ?, start = ?, year = ?, status = ? WHERE id = ?',
        [
          (type || '').trim(),
          (title || '').trim(),
          (content || '').trim(),
          (place || '').trim(),
          projectYear,
          projectYear,
          Number(status) || 1,
          id
        ]
      );
      res.json({ success: true, message: 'Cập nhật thông tin dự án thành công' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi cập nhật dự án' });
    }
  });

  // Ẩn / Thay đổi trạng thái dự án (status = 3: đang ẩn, status = 2: đã duyệt xong, status = 1: đang trình duyệt)
  router.patch('/projects/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body || {};
    try {
      await pool.query('UPDATE project SET status = ? WHERE id = ?', [Number(status) || 1, id]);
      res.json({ success: true, message: 'Đã cập nhật trạng thái dự án' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi cập nhật trạng thái dự án' });
    }
  });

  // Ẩn dự án nhanh (status = 3)
  router.patch('/projects/:id/hide', async (req, res) => {
    const { id } = req.params;
    try {
      await pool.query('UPDATE project SET status = 3 WHERE id = ?', [id]);
      res.json({ success: true, message: 'Đã ẩn dự án thành công' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi ẩn dự án' });
    }
  });

  // Xoá dự án và file hình ảnh tương ứng
  router.delete('/projects/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const [rows] = await pool.query('SELECT image FROM project WHERE id = ?', [id]);
      if (rows && rows.length > 0 && rows[0].image) {
        const imgPath = rows[0].image;
        const filename = path.basename(imgPath);
        const physicalPath = path.resolve(__dirname, '../../uploads/project', filename);
        if (fs.existsSync(physicalPath)) {
          try {
            await fs.promises.unlink(physicalPath);
          } catch {
            // ignore unlink error
          }
        }
      }

      await pool.query('DELETE FROM project WHERE id = ?', [id]);
      res.json({ success: true, message: 'Đã xoá dự án và hình ảnh thành công' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi xoá dự án' });
    }
  });

  // 17. Quản lý danh mục thiết bị & vật tư (bảng device)
  // Lấy danh sách thiết bị
  router.get('/device', async (req, res) => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS device (
          id INT AUTO_INCREMENT PRIMARY KEY,
          time DATETIME DEFAULT CURRENT_TIMESTAMP,
          brand VARCHAR(255) NOT NULL,
          name VARCHAR(255) NOT NULL,
          image VARCHAR(500) DEFAULT NULL,
          status INT NOT NULL DEFAULT 1
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      const [rows] = await pool.query('SELECT * FROM device ORDER BY id DESC');
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi truy vấn bảng device' });
    }
  });

  // Thêm thiết bị mới
  router.post('/device', async (req, res) => {
    const { brand, name, imageBase64, imageFileName } = req.body || {};
    if (!brand || !name) {
      return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ Hãng sản xuất và Tên thiết bị.' });
    }

    try {
      let imageDbPath = '';
      if (imageBase64 && typeof imageBase64 === 'string') {
        const filename = generateSafeImageName('device', imageFileName);

        // Thư mục lưu ảnh uploads/device
        const uploadsDeviceDir = path.resolve(__dirname, '../../uploads/device');
        if (!fs.existsSync(uploadsDeviceDir)) {
          fs.mkdirSync(uploadsDeviceDir, { recursive: true });
        }
        const filePath = path.join(uploadsDeviceDir, filename);
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        await fs.promises.writeFile(filePath, Buffer.from(base64Data, 'base64'));

        // Lưu bản sao vào uploads/news để đảm bảo tương thích đường dẫn \AAA_Backend\uploads\news\...
        const uploadsNewsDir = path.resolve(__dirname, '../../uploads/news');
        if (!fs.existsSync(uploadsNewsDir)) {
          fs.mkdirSync(uploadsNewsDir, { recursive: true });
        }
        const newsFilePath = path.join(uploadsNewsDir, filename);
        try {
          await fs.promises.copyFile(filePath, newsFilePath);
        } catch {
          // ignore copy error
        }

        // Cột image lưu đường dẫn /AAA_Backend/uploads/device/device[dd-mm-yy][codeimg]
        imageDbPath = `/AAA_Backend/uploads/device/${filename}`;
      }

      const [result] = await pool.query(
        'INSERT INTO device (time, brand, name, image, status) VALUES (NOW(), ?, ?, ?, 1)',
        [brand.trim(), name.trim(), imageDbPath || null]
      );

      res.json({
        success: true,
        message: 'Đăng thiết bị thành công',
        id: result.insertId,
        image: imageDbPath
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi lưu thiết bị' });
    }
  });

  // Cập nhật thông tin thiết bị (sửa brand, name, status, giữ nguyên image hoặc cập nhật nếu có)
  router.put('/device/:id', async (req, res) => {
    const { id } = req.params;
    const { brand, name, status, imageBase64, imageFileName } = req.body || {};

    if (!brand || !name) {
      return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ Hãng sản xuất và Tên thiết bị.' });
    }

    try {
      let imageDbPath = undefined;
      if (imageBase64 && typeof imageBase64 === 'string' && imageBase64.startsWith('data:image')) {
        const filename = generateSafeImageName('device', imageFileName);
        const uploadsDeviceDir = path.resolve(__dirname, '../../uploads/device');
        if (!fs.existsSync(uploadsDeviceDir)) {
          fs.mkdirSync(uploadsDeviceDir, { recursive: true });
        }
        const filePath = path.join(uploadsDeviceDir, filename);
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        await fs.promises.writeFile(filePath, Buffer.from(base64Data, 'base64'));

        const uploadsNewsDir = path.resolve(__dirname, '../../uploads/news');
        if (!fs.existsSync(uploadsNewsDir)) {
          fs.mkdirSync(uploadsNewsDir, { recursive: true });
        }
        try {
          await fs.promises.copyFile(filePath, path.join(uploadsNewsDir, filename));
        } catch {
          // ignore
        }

        imageDbPath = `/AAA_Backend/uploads/device/${filename}`;
      }

      if (imageDbPath !== undefined) {
        await pool.query(
          'UPDATE device SET brand = ?, name = ?, status = ?, image = ? WHERE id = ?',
          [brand.trim(), name.trim(), Number(status) || 1, imageDbPath, id]
        );
      } else {
        await pool.query(
          'UPDATE device SET brand = ?, name = ?, status = ? WHERE id = ?',
          [brand.trim(), name.trim(), Number(status) || 1, id]
        );
      }

      res.json({ success: true, message: 'Cập nhật thông tin thiết bị thành công' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi cập nhật thiết bị' });
    }
  });

  // Ẩn thiết bị (status = 2)
  router.patch('/device/:id/hide', async (req, res) => {
    const { id } = req.params;
    try {
      await pool.query('UPDATE device SET status = 2 WHERE id = ?', [id]);
      res.json({ success: true, message: 'Đã ẩn thiết bị thành công' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi ẩn thiết bị' });
    }
  });

  // Thay đổi trạng thái thiết bị linh hoạt (1: Đăng bài, 2: Đang ẩn)
  router.patch('/device/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body || {};
    try {
      await pool.query('UPDATE device SET status = ? WHERE id = ?', [Number(status) || 1, id]);
      res.json({ success: true, message: 'Đã cập nhật trạng thái thiết bị' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi cập nhật trạng thái thiết bị' });
    }
  });

  // Xoá thiết bị và hình ảnh tương ứng
  router.delete('/device/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const [rows] = await pool.query('SELECT image FROM device WHERE id = ?', [id]);
      if (rows && rows.length > 0 && rows[0].image) {
        const imgPath = rows[0].image;
        const filename = path.basename(imgPath);

        const deviceFile = path.resolve(__dirname, '../../uploads/device', filename);
        if (fs.existsSync(deviceFile)) {
          try {
            await fs.promises.unlink(deviceFile);
          } catch {
            // ignore
          }
        }

        const newsFile = path.resolve(__dirname, '../../uploads/news', filename);
        if (fs.existsSync(newsFile)) {
          try {
            await fs.promises.unlink(newsFile);
          } catch {
            // ignore
          }
        }
      }

      await pool.query('DELETE FROM device WHERE id = ?', [id]);
      res.json({ success: true, message: 'Đã xoá thiết bị và hình ảnh thành công' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi xoá thiết bị' });
    }
  });

  // =========================================================================
  // API QUẢN LÝ DỰ ÁN & THIẾT BỊ IOT (locations, gateways, devices)
  // =========================================================================

  // Khởi tạo bảng nếu chưa có
  async function ensureIotTables() {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS locations (
          location_id INT AUTO_INCREMENT PRIMARY KEY,
          location_name VARCHAR(255) NOT NULL DEFAULT 'Dự án mới chưa đặt tên',
          address VARCHAR(255) DEFAULT 'Chưa cập nhật địa chỉ',
          customer_name VARCHAR(255) DEFAULT NULL,
          customer_phone VARCHAR(50) DEFAULT NULL,
          customer_email VARCHAR(255) DEFAULT NULL,
          customer_pass VARCHAR(255) DEFAULT '3AH@me',
          status VARCHAR(50) DEFAULT 'installing',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      try {
        await pool.query("ALTER TABLE locations ADD COLUMN customer_pass VARCHAR(255) DEFAULT '3AH@me' AFTER customer_email");
      } catch (e) {
        // Cột customer_pass đã tồn tại
      }

      await pool.query(`
        CREATE TABLE IF NOT EXISTS gateways (
          gateway_id INT AUTO_INCREMENT PRIMARY KEY,
          location_id INT DEFAULT NULL,
          gateway_sn VARCHAR(100) NOT NULL UNIQUE,
          ip_address VARCHAR(50) DEFAULT '192.168.1.250',
          status VARCHAR(50) DEFAULT 'offline',
          last_seen DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_gateways_location FOREIGN KEY (location_id) REFERENCES locations (location_id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS devices (
          device_id INT AUTO_INCREMENT PRIMARY KEY,
          gateway_id INT NOT NULL,
          device_code VARCHAR(100) NOT NULL UNIQUE,
          device_name VARCHAR(255) NOT NULL,
          device_type VARCHAR(50) DEFAULT 'sensor',
          slave_address INT DEFAULT 1,
          floor VARCHAR(100) DEFAULT 'Khu vực chính',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_devices_gateway FOREIGN KEY (gateway_id) REFERENCES gateways (gateway_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS telemetry_data (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          device_id INT NOT NULL,
          param_name VARCHAR(50) NOT NULL,
          param_value FLOAT NOT NULL,
          recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_device_time (device_id, recorded_at DESC),
          CONSTRAINT fk_telemetry_device FOREIGN KEY (device_id) REFERENCES devices (device_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // Nếu bảng locations rỗng, nạp dữ liệu mẫu ban đầu để hệ thống có dữ liệu hiển thị ngay
      const [check] = await pool.query('SELECT COUNT(*) as count FROM locations');
      if (check[0].count === 0) {
        // Dự án 1: Biệt Thự Homeland
        const [l1] = await pool.query(`
          INSERT INTO locations (location_name, address, customer_name, customer_phone, customer_email, status, created_at)
          VALUES ('Biệt Thự Homeland - Nhà 4 Tầng', 'Khu Đô Thị Ecopark, Văn Giang, Hưng Yên', 'Nguyễn Văn An', '0912 345 678', 'nguyenvanan.ecopark@gmail.com', 'active', '2026-10-15 09:30:00')
        `);
        const [g1] = await pool.query(`
          INSERT INTO gateways (location_id, gateway_sn, ip_address, status, last_seen, created_at)
          VALUES (?, 'RCU100_SN_003', '192.168.1.250', 'online', NOW(), '2026-10-15 09:30:00')
        `, [l1.insertId]);
        const g1Id = g1.insertId;
        await pool.query(`
          INSERT INTO devices (gateway_id, device_code, device_name, device_type, slave_address, floor) VALUES
          (?, 'TEMP_T1_01', 'Cảm biến nhiệt độ CB Tầng 1', 'sensor', 1, 'Tầng 1'),
          (?, 'EM_T1_01', 'Công tơ điện thông minh Tầng 1', 'sensor', 2, 'Tầng 1'),
          (?, 'TEMP_T2_01', 'Cảm biến nhiệt độ CB Tầng 2', 'sensor', 3, 'Tầng 2'),
          (?, 'EM_T2_01', 'Công tơ điện thông minh Tầng 2', 'sensor', 4, 'Tầng 2'),
          (?, 'TEMP_T3_01', 'Cảm biến nhiệt độ CB Tầng 3', 'sensor', 5, 'Tầng 3'),
          (?, 'EM_T3_01', 'Công tơ điện thông minh Tầng 3', 'sensor', 6, 'Tầng 3'),
          (?, 'TEMP_T4_01', 'Cảm biến nhiệt độ CB Tầng 4', 'sensor', 7, 'Tầng 4'),
          (?, 'EM_T4_01', 'Công tơ điện thông minh Tầng 4', 'sensor', 8, 'Tầng 4')
        `, [g1Id, g1Id, g1Id, g1Id, g1Id, g1Id, g1Id, g1Id]);

        // Dự án 2: Căn Hộ Duplex Sunshine City
        const [l2] = await pool.query(`
          INSERT INTO locations (location_name, address, customer_name, customer_phone, customer_email, status, created_at)
          VALUES ('Căn Hộ Duplex Sunshine City - P.802', 'KĐT Ciputra, Tây Hồ, Hà Nội', 'Trần Thị Mai', '0988 765 432', 'tranthimai.sunshine@gmail.com', 'active', '2026-10-16 14:15:00')
        `);
        const [g2] = await pool.query(`
          INSERT INTO gateways (location_id, gateway_sn, ip_address, status, last_seen, created_at)
          VALUES (?, 'RCU100_SN_007', '192.168.1.251', 'online', NOW(), '2026-10-16 14:15:00')
        `, [l2.insertId]);
        const g2Id = g2.insertId;
        await pool.query(`
          INSERT INTO devices (gateway_id, device_code, device_name, device_type, slave_address, floor) VALUES
          (?, 'LIGHT_PK_01', 'Hệ thống đèn Phòng Khách', 'light', 1, 'Phòng Khách'),
          (?, 'AC_PK_01', 'Điều hòa Phòng Khách', 'ac', 2, 'Phòng Khách'),
          (?, 'FAN_BEP_01', 'Quạt hút mùi Bếp', 'motor', 3, 'Bếp'),
          (?, 'AC_PN1_01', 'Điều hòa Phòng Ngủ Master', 'ac', 4, 'Phòng Ngủ 1'),
          (?, 'LIGHT_PN2_01', 'Đèn chiếu sáng Phòng Ngủ 2', 'light', 5, 'Phòng Ngủ 2')
        `, [g2Id, g2Id, g2Id, g2Id, g2Id]);

        // Dự án 3: TechHub Tower
        const [l3] = await pool.query(`
          INSERT INTO locations (location_name, address, customer_name, customer_phone, customer_email, status, created_at)
          VALUES ('Tòa Nhà Văn Phòng TechHub Tower', 'KCN Đại Đồng - Hoàn Sơn, Bắc Ninh', 'BQL TechHub', '0866 57 2388', 'bql.techhub@gmail.com', 'installing', '2026-10-17 11:00:00')
        `);
        const [g3] = await pool.query(`
          INSERT INTO gateways (location_id, gateway_sn, ip_address, status, last_seen, created_at)
          VALUES (?, 'RCU100_SN_012', '192.168.1.252', 'offline', '2026-10-17 11:00:00', '2026-10-17 11:00:00')
        `, [l3.insertId]);
        const g3Id = g3.insertId;
        await pool.query(`
          INSERT INTO devices (gateway_id, device_code, device_name, device_type, slave_address, floor) VALUES
          (?, 'FAN_HVAC_B1', 'Quạt thông gió Tầng Hầm', 'motor', 1, 'Tầng Hầm'),
          (?, 'EM_SANH_01', 'Công tơ tổng Sảnh Tầng 1', 'sensor', 2, 'Sảnh Tầng 1')
        `, [g3Id, g3Id]);
      }
    } catch (err) {
      console.error('Lỗi khởi tạo bảng IoT:', err.message);
    }
  }

  // Gọi ensureIotTables khi khởi tạo router
  ensureIotTables();

  // 1. Lấy danh sách toàn bộ dự án kèm thông tin Gateway và Devices từ Database
  router.get('/customer-projects', async (req, res) => {
    try {
      await ensureIotTables();
      const [locations] = await pool.query(`
        SELECT 
          l.location_id AS id,
          l.location_name AS projectName,
          l.address,
          l.customer_name AS customerName,
          COALESCE(l.customer_phone, 'Chưa có SĐT') AS phone,
          COALESCE(l.customer_email, 'Chưa có Email') AS email,
          COALESCE(l.customer_pass, '3AH@me') AS customer_pass,
          l.status,
          DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i') AS createdAt,
          g.gateway_id AS gatewayId,
          COALESCE(g.gateway_sn, 'CHƯA_GÁN') AS gatewaySn,
          COALESCE(g.ip_address, '192.168.1.250') AS gatewayIp,
          COALESCE(g.status, 'offline') AS gatewayStatus,
          g.last_seen AS lastSeen
        FROM locations l
        LEFT JOIN gateways g ON l.location_id = g.location_id
        ORDER BY l.location_id DESC
      `);

      const [allDevices] = await pool.query(`
        SELECT 
          device_id AS id,
          gateway_id AS gatewayId,
          device_code,
          device_name,
          device_type,
          slave_address,
          COALESCE(floor, 'Khu vực chính') AS location_name,
          DATE_FORMAT(created_at, '%Y-%m-%d') AS created_at
        FROM devices
        ORDER BY slave_address ASC, device_id ASC
      `);

      // Gộp devices vào từng location
      const result = locations.map(loc => {
        const devList = allDevices.filter(d => d.gatewayId === loc.gatewayId);
        return {
          id: loc.id,
          projectName: loc.projectName,
          address: loc.address,
          phone: loc.phone,
          email: loc.email,
          customer_pass: loc.customer_pass || '3AH@me',
          status: loc.status || 'installing',
          createdAt: loc.createdAt,
          gateway: {
            gateway_sn: loc.gatewaySn,
            ip_address: loc.gatewayIp,
            status: loc.gatewayStatus
          },
          devices: devList.map(d => ({
            id: d.id,
            device_code: d.device_code,
            device_name: d.device_name,
            device_type: d.device_type,
            slave_address: d.slave_address,
            location_name: d.location_name,
            created_at: d.created_at
          }))
        };
      });

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 2. Tạo mới dự án vào Database (locations -> gateways -> devices)
  router.post('/customer-projects', async (req, res) => {
    const { projectName, address, phone, email, customer_pass, gateway, status, devices } = req.body;
    try {
      await ensureIotTables();
      const [locResult] = await pool.query(`
        INSERT INTO locations (location_name, address, customer_phone, customer_email, customer_pass, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [projectName, address, phone, email || null, customer_pass || '3AH@me', status || 'installing']);
      const locationId = locResult.insertId;

      let gatewayId = null;
      if (gateway && gateway.gateway_sn) {
        // Kiểm tra gateway_sn đã tồn tại chưa
        const [existingGws] = await pool.query('SELECT gateway_id FROM gateways WHERE gateway_sn = ?', [gateway.gateway_sn.toUpperCase()]);
        if (existingGws.length > 0) {
          gatewayId = existingGws[0].gateway_id;
          await pool.query('UPDATE gateways SET location_id = ?, ip_address = ?, status = ? WHERE gateway_id = ?', 
            [locationId, gateway.ip_address || '192.168.1.250', gateway.status || 'online', gatewayId]);
        } else {
          const [gwResult] = await pool.query(`
            INSERT INTO gateways (location_id, gateway_sn, ip_address, status)
            VALUES (?, ?, ?, ?)
          `, [locationId, gateway.gateway_sn.toUpperCase(), gateway.ip_address || '192.168.1.250', gateway.status || 'online']);
          gatewayId = gwResult.insertId;
        }
      }

      // Thêm danh mục devices nếu có
      if (gatewayId && Array.isArray(devices) && devices.length > 0) {
        for (const dev of devices) {
          await pool.query(`
            INSERT INTO devices (gateway_id, device_code, device_name, device_type, slave_address, floor)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE device_name = VALUES(device_name), slave_address = VALUES(slave_address), floor = VALUES(floor)
          `, [gatewayId, dev.device_code.toUpperCase(), dev.device_name, dev.device_type || 'sensor', Number(dev.slave_address) || 1, dev.location_name || dev.floor || 'Khu vực chính']);
        }
      }

      res.json({ success: true, message: 'Đã tạo dự án thành công vào database', locationId });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 3. Cập nhật thông tin dự án & Gateway
  router.put('/customer-projects/:id', async (req, res) => {
    const { id } = req.params;
    const { projectName, address, phone, email, customer_pass, gateway, status } = req.body;
    try {
      await pool.query(`
        UPDATE locations 
        SET location_name = ?, address = ?, customer_phone = ?, customer_email = ?, customer_pass = COALESCE(?, customer_pass), status = ?
        WHERE location_id = ?
      `, [projectName, address, phone, email, customer_pass || null, status, id]);

      if (gateway && gateway.gateway_sn) {
        await pool.query(`
          UPDATE gateways 
          SET gateway_sn = ?, ip_address = ?, status = ?
          WHERE location_id = ?
        `, [gateway.gateway_sn.toUpperCase(), gateway.ip_address, gateway.status, id]);
      }

      res.json({ success: true, message: 'Đã cập nhật dự án thành công' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 4. Xóa dự án khỏi Database (xóa các hàng liên quan trong devices, gateways và locations)
  router.delete('/customer-projects/:id', async (req, res) => {
    const { id } = req.params;
    try {
      // 1. Tìm các gateway liên quan đến dự án này
      const [gws] = await pool.query('SELECT gateway_id FROM gateways WHERE location_id = ?', [id]);
      if (gws.length > 0) {
        const gwIds = gws.map(g => g.gateway_id);
        // 2. Xóa toàn bộ các thiết bị (devices) thuộc các gateway này
        await pool.query('DELETE FROM devices WHERE gateway_id IN (?)', [gwIds]);
        // 3. Xóa các gateways thuộc dự án này
        await pool.query('DELETE FROM gateways WHERE location_id = ?', [id]);
      }
      // 4. Xóa dự án khỏi bảng locations
      await pool.query('DELETE FROM locations WHERE location_id = ?', [id]);

      res.json({ success: true, message: 'Đã xóa toàn bộ dự án, Gateway và Devices liên quan khỏi database thành công' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 5. Thêm thiết bị mới vào Gateway của Dự án
  router.post('/customer-projects/:id/devices', async (req, res) => {
    const { id } = req.params;
    const { device_code, device_name, device_type, slave_address, floor, location_name } = req.body;
    try {
      const [gws] = await pool.query('SELECT gateway_id FROM gateways WHERE location_id = ?', [id]);
      if (gws.length === 0) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy Gateway của dự án này' });
      }
      const gatewayId = gws[0].gateway_id;
      const [result] = await pool.query(`
        INSERT INTO devices (gateway_id, device_code, device_name, device_type, slave_address, floor)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [gatewayId, device_code.toUpperCase(), device_name, device_type || 'sensor', Number(slave_address) || 1, floor || location_name || 'Khu vực chính']);

      res.json({ success: true, message: 'Đã thêm thiết bị vào database', deviceId: result.insertId });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 6. Xóa thiết bị khỏi database
  router.delete('/customer-devices/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    try {
      await pool.query('DELETE FROM devices WHERE device_id = ?', [deviceId]);
      res.json({ success: true, message: 'Đã xóa thiết bị thành công' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 7. Nhận số liệu viễn trắc (Telemetry) từ Gateway / Cảm biến / MQTTX lưu vào bảng telemetry_data (Upsert 1 hàng/device_id)
  router.post('/telemetry-data', async (req, res) => {
    const { device_code, device_id, param_name, param_value, measurements } = req.body;
    try {
      let targetDeviceId = device_id;

      // Nếu truyền mã device_code, tự tìm device_id tương ứng trong bảng devices
      if (!targetDeviceId && device_code) {
        const [devs] = await pool.query('SELECT device_id FROM devices WHERE device_code = ?', [String(device_code).toUpperCase()]);
        if (devs.length > 0) {
          targetDeviceId = devs[0].device_id;
        } else {
          const [insDev] = await pool.query(
            'INSERT INTO devices (gateway_id, device_code, device_name, device_type, slave_address, floor) VALUES (1, ?, ?, ?, 1, ?)',
            [String(device_code).toUpperCase(), `Thiết bị ${device_code}`, 'sensor', 'Khu vực chính']
          );
          targetDeviceId = insDev.insertId;
        }
      }

      if (!targetDeviceId) {
        return res.status(400).json({ success: false, message: 'Vui lòng cung cấp device_code hoặc device_id' });
      }

      const m = { ...(measurements || {}) };
      if (param_name && param_value !== undefined) {
        m[param_name] = Number(param_value);
      }

      const temp = m.temperature !== undefined ? Number(m.temperature) : (m.temp !== undefined ? Number(m.temp) : null);
      const humi = m.humidity !== undefined ? Number(m.humidity) : (m.humi !== undefined ? Number(m.humi) : null);
      const power = m.power !== undefined ? Number(m.power) : (m.watt !== undefined ? Number(m.watt) : null);
      const volt = m.voltage !== undefined ? Number(m.voltage) : (m.volt !== undefined ? Number(m.volt) : null);
      const curr = m.current !== undefined ? Number(m.current) : (m.curr !== undefined ? Number(m.curr) : null);

      await pool.query(`
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
        targetDeviceId,
        (temp !== null && !isNaN(temp)) ? temp : null,
        (humi !== null && !isNaN(humi)) ? humi : null,
        (power !== null && !isNaN(power)) ? power : null,
        (volt !== null && !isNaN(volt)) ? volt : null,
        (curr !== null && !isNaN(curr)) ? curr : null,
        JSON.stringify(m)
      ]);

      if (broadcastWs) {
        broadcastWs({
          type: 'TELEMETRY_DATA_SAVED',
          device_id: targetDeviceId,
          device_code: device_code,
          measurements: m,
          recorded_at: new Date().toISOString()
        });
      }

      res.json({ success: true, message: 'Đã cập nhật 1 hàng số liệu đo đạc vào bảng telemetry_data thành công', device_id: targetDeviceId });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 8. Lấy danh sách số liệu đo mới nhất từ bảng telemetry_data (JOIN với devices, gateways, locations)
  router.get('/telemetry-data', async (req, res) => {
    const { device_code, location_id, gateway_sn } = req.query;
    try {
      let sql = `
        SELECT 
          t.device_id,
          d.device_code,
          d.device_name,
          d.device_type,
          d.slave_address,
          d.floor,
          g.gateway_id,
          g.gateway_sn,
          g.ip_address AS gateway_ip,
          COALESCE(g.status, 'offline') AS gateway_status,
          l.location_id,
          COALESCE(l.location_name, 'Dự án nội bộ') AS project_name,
          l.address AS project_address,
          t.temperature,
          t.humidity,
          t.power,
          t.voltage,
          t.current,
          t.raw_data,
          DATE_FORMAT(t.recorded_at, '%Y-%m-%d %H:%i:%s') AS recorded_at
        FROM telemetry_data t
        JOIN devices d ON t.device_id = d.device_id
        LEFT JOIN gateways g ON d.gateway_id = g.gateway_id
        LEFT JOIN locations l ON g.location_id = l.location_id
        WHERE 1=1
      `;
      const params = [];
      if (device_code) {
        sql += ' AND d.device_code = ?';
        params.push(String(device_code).toUpperCase());
      }
      if (location_id) {
        sql += ' AND l.location_id = ?';
        params.push(Number(location_id));
      }
      if (gateway_sn) {
        sql += ' AND g.gateway_sn = ?';
        params.push(String(gateway_sn));
      }
      sql += ' ORDER BY t.recorded_at DESC';

      const [rows] = await pool.query(sql, params);
      res.json({ success: true, count: rows.length, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  return router;
}

