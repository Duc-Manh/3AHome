import express from 'express';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
      const [rows] = await pool.query(
        'SELECT id, time, full_name, room, position, gmail, password, phone, authen, state FROM login ORDER BY id ASC'
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
          (SELECT COUNT(DISTINCT session_id) FROM site_visits) AS total
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
          (SELECT COUNT(DISTINCT session_id) FROM site_visits) AS total
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
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || 'Lỗi lấy thống kê truy cập' });
    }
  });

  // 14. Tiếp nhận đăng ký tư vấn miễn phí từ trang chủ (Bảng consult trong database 3ahome)
  router.post('/consult', async (req, res) => {
    const { full_name, email, phone, type, content } = req.body || {};
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

      const [rows] = await pool.query('SELECT * FROM news ORDER BY id DESC');
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
      if (imageBase64) {
        // Tên file có dạng: [dd-mm-yyyy][codeimg]
        let filename = imageFileName;
        if (!filename) {
          const now = new Date();
          const dd = String(now.getDate()).padStart(2, '0');
          const mm = String(now.getMonth() + 1).padStart(2, '0');
          const yyyy = now.getFullYear();
          const codeimg = Math.random().toString(36).substring(2, 8).toUpperCase();
          filename = `[${dd}-${mm}-${yyyy}][${codeimg}].jpg`;
        }

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
        let filename = imageFileName;
        if (!filename) {
          const now = new Date();
          const dd = String(now.getDate()).padStart(2, '0');
          const mm = String(now.getMonth() + 1).padStart(2, '0');
          const yyyy = now.getFullYear();
          const codeimg = Math.random().toString(36).substring(2, 8).toUpperCase();
          filename = `[${dd}-${mm}-${yyyy}][${codeimg}].jpg`;
        }

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

      const [rows] = await pool.query('SELECT * FROM project ORDER BY id DESC');
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
      if (imageBase64) {
        let filename = imageFileName;
        if (!filename) {
          const now = new Date();
          const dd = String(now.getDate()).padStart(2, '0');
          const mm = String(now.getMonth() + 1).padStart(2, '0');
          const yy = String(now.getFullYear()).slice(-2);
          const codeimg = Math.random().toString(36).substring(2, 8).toUpperCase();
          filename = `proj[${dd}-${mm}-${yy}][${codeimg}].jpg`;
        }

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

  return router;
}

