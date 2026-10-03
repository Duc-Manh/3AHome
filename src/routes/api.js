import express from 'express';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../config/db.js';

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

      console.log(`[CONSULT] Nhận yêu cầu tư vấn mới từ ${full_name} (${phone}) - Loại: ${type || 'Tư vấn giải pháp'}. Gửi thông báo đến:`, notify_emails || ['3ahomeadmin@gmail.com', 'son.lm@3ahome.vn']);

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

  return router;
}

