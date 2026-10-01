import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// Tạo Connection Pool tới MySQL
export const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'aaa_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Hàm kiểm tra kết nối tới MySQL
export async function testDbConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Kết nối cơ sở dữ liệu MySQL thành công!');
    connection.release();
    return true;
  } catch (err) {
    console.error('❌ Lỗi kết nối MySQL:', err.message);
    return false;
  }
}
