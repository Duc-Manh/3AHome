-- Script khởi tạo cơ sở dữ liệu 3ahome trên VPS Windows (103.68.85.209)
-- Mở tab Query trong MySQL Workbench, dán nội dung này và nhấn Execute (biểu tượng tia sét)

CREATE DATABASE IF NOT EXISTS `3ahome` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `3ahome`;

-- 1. Bảng simu: Lưu đăng ký thông tin người dùng phòng mô phỏng 3D từ Web 3ahome.vn & Mobile
CREATE TABLE IF NOT EXISTS `simu` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `full_name` VARCHAR(255) NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `phone` VARCHAR(50) NOT NULL,
  `count` INT DEFAULT 1,
  `time` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Bảng login: Quản lý tài khoản đăng nhập hệ thống phân quyền (authen 1: Admin, 2: Employee)
CREATE TABLE IF NOT EXISTS `login` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `time` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `full_name` VARCHAR(255) NOT NULL,
  `room` VARCHAR(100) DEFAULT NULL,
  `position` VARCHAR(100) DEFAULT NULL,
  `gmail` VARCHAR(255) NOT NULL UNIQUE,
  `password` VARCHAR(255) NOT NULL,
  `phone` VARCHAR(50) DEFAULT NULL,
  `authen` INT NOT NULL DEFAULT 2,
  `state` VARCHAR(50) DEFAULT 'active'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Bảng devices: Quản lý thiết bị Smart Home (Đèn, điều hòa, quạt, rèm cửa...)
CREATE TABLE IF NOT EXISTS `devices` (
  `id` VARCHAR(100) PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `cluster_id` VARCHAR(50) DEFAULT 'living_room',
  `room_id` VARCHAR(50) DEFAULT 'living',
  `type` VARCHAR(50) NOT NULL,
  `is_online` TINYINT(1) DEFAULT 1,
  `is_on` TINYINT(1) DEFAULT 0,
  `brightness` INT DEFAULT 100,
  `color_value` BIGINT DEFAULT 4294967295,
  `current_temp` FLOAT DEFAULT 25.0,
  `target_temp` FLOAT DEFAULT 24.0,
  `ac_mode` VARCHAR(50) DEFAULT 'cool',
  `fan_speed` VARCHAR(50) DEFAULT 'auto',
  `humidity` FLOAT DEFAULT 60.0,
  `power_watts` FLOAT DEFAULT 0.0,
  `mqtt_topic` VARCHAR(255) DEFAULT NULL,
  `last_updated` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Bảng activity_logs: Ghi lịch sử hoạt động thiết bị và thao tác điều khiển
CREATE TABLE IF NOT EXISTS `activity_logs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `source` VARCHAR(100) DEFAULT 'system',
  `device_name` VARCHAR(100) DEFAULT NULL,
  `message` TEXT NOT NULL,
  `level` VARCHAR(20) DEFAULT 'info',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Dữ liệu thiết bị mẫu ban đầu (để Web và Mobile có dữ liệu hiển thị ngay)
INSERT INTO `devices` (`id`, `name`, `cluster_id`, `room_id`, `type`, `is_online`, `is_on`, `brightness`, `color_value`, `current_temp`, `target_temp`, `ac_mode`, `fan_speed`, `humidity`, `power_watts`)
VALUES
('dev_light_01', 'Đèn trần chính', 'living_room', 'living', 'light', 1, 1, 85, 4120814347, 26.5, 24.0, 'cool', 'auto', 58.0, 35.0),
('dev_ac_01', 'Điều hòa Daikin', 'living_room', 'living', 'ac', 1, 1, 100, 4294967295, 25.0, 23.0, 'cool', 'medium', 55.0, 850.0),
('dev_curtain_01', 'Rèm cửa tự động', 'living_room', 'living', 'curtain', 1, 0, 0, 4294967295, 26.0, 24.0, 'auto', 'auto', 58.0, 15.0),
('dev_light_bed_01', 'Đèn ngủ ấm', 'bedroom', 'bed', 'light', 1, 0, 30, 4120814347, 27.0, 25.0, 'cool', 'auto', 62.0, 12.0),
('dev_fan_01', 'Quạt trần phòng khách', 'living_room', 'living', 'fan', 1, 1, 100, 4294967295, 26.0, 24.0, 'cool', 'high', 58.0, 65.0)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- 5. Bảng site_visits: Thu thập và thống kê lượng truy cập thực tế của người dùng
CREATE TABLE IF NOT EXISTS `site_visits` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `session_id` VARCHAR(100) NOT NULL,
  `ip_address` VARCHAR(100) DEFAULT NULL,
  `user_agent` TEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `last_active` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_session (`session_id`),
  INDEX idx_created (`created_at`),
  INDEX idx_active (`last_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Bảng consult: Lưu thông tin khách hàng đăng ký nhận tư vấn miễn phí
CREATE TABLE IF NOT EXISTS `consult` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `time` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `full_name` VARCHAR(255) NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `phone` VARCHAR(50) NOT NULL,
  `type` VARCHAR(100) NOT NULL,
  `content` TEXT DEFAULT NULL,
  `status` INT NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Bảng news: Quản lý bài đăng tin tức, dự án, sự kiện doanh nghiệp
CREATE TABLE IF NOT EXISTS `news` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `time` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `topic` VARCHAR(100) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `content` TEXT NOT NULL,
  `image` VARCHAR(255) DEFAULT NULL,
  `author` VARCHAR(255) NOT NULL,
  `status` INT NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Bảng project: Quản lý hồ sơ dự án triển khai thông minh 3AHOME
CREATE TABLE IF NOT EXISTS `project` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `time` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `type` VARCHAR(255) NOT NULL,
  `title` VARCHAR(500) NOT NULL,
  `content` TEXT NOT NULL,
  `place` VARCHAR(255) NOT NULL,
  `year` VARCHAR(50) DEFAULT NULL,
  `start` VARCHAR(50) DEFAULT NULL,
  `image` VARCHAR(500) DEFAULT NULL,
  `status` INT NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

