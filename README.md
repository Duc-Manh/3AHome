# AAA_Backend

Máy chủ API & WebSocket Gateway trung tâm cho hệ sinh thái **AAA (Web, Mobile, IoT)**.

## 1. Cài đặt và chạy

### Chạy trực tiếp
```bash
npm install
npm start
```

### Chạy chế độ phát triển (Tự reload khi sửa file)
```bash
npm run dev
```

## 2. Cấu hình biến môi trường (.env)

Tạo file `.env` với nội dung:
```env
PORT=5000
DB_HOST=localhost       # Dùng localhost khi chạy trên VPS, hoặc IP VPS 103.68.85.209 khi test từ xa
DB_PORT=3306
DB_USER=root
DB_PASSWORD=mat_khau_mysql_cua_ban
DB_NAME=aaa_db
```

## 3. Danh sách Endpoints

* `GET /api/health`: Kiểm tra trạng thái máy chủ và kết nối MySQL
* `GET /api/devices`: Lấy danh sách toàn bộ thiết bị
* `POST /api/devices/:id/command`: Điều khiển thiết bị (bật/tắt, chỉnh nhiệt độ, độ sáng...)
* `POST /api/telemetry`: Nhận số liệu từ cảm biến / cụm thiết bị ngoại vi
* `GET /api/logs`: Lấy lịch sử hoạt động
* `ws://103.68.85.209:5000/ws`: Kênh WebSocket giao tiếp thời gian thực
