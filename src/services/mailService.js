import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const smtpUser = process.env.SMTP_USER || '3ahomeadmin@gmail.com';
const smtpPass = (process.env.SMTP_PASS || 'mtvngkqxvzyvjjhl').replace(/\s+/g, '');
const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
const smtpPort = parseInt(process.env.SMTP_PORT || '465', 10);
const notifyCc = process.env.SMTP_NOTIFY_CC || 'son.lm@3ahome.vn';

// Tạo SMTP Transporter kết nối trực tiếp đến Google Gmail
export const mailTransporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465, // true for 465, false for 587
  auth: {
    user: smtpUser,
    pass: smtpPass
  },
  tls: {
    rejectUnauthorized: false
  }
});

/**
 * Gửi email thông báo yêu cầu khảo sát & tư vấn mới
 */
export async function sendConsultNotificationMail({
  full_name,
  email,
  phone,
  type = 'Tư vấn giải pháp',
  content = '',
  source = 'Website 3AHOME'
}) {
  const submitTime = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const subject = `[3AHOME] Yêu cầu khảo sát & tư vấn mới từ ${full_name} (${phone})`;

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; color: #1e293b; }
        .mail-card { max-width: 620px; margin: 0 auto; background: #ffffff; border-radius: 14px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.08); border: 1px solid #e2e8f0; }
        .mail-header { background: linear-gradient(135deg, #1D58BB 0%, #153e85 100%); padding: 24px; text-align: center; color: #ffffff; }
        .mail-header h1 { margin: 0 0 6px 0; font-size: 20px; font-weight: 700; letter-spacing: 0.5px; }
        .mail-header p { margin: 0; font-size: 13px; opacity: 0.9; }
        .mail-body { padding: 28px 24px; }
        .tag-badge { display: inline-block; background-color: #e0f2fe; color: #0284c7; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; margin-bottom: 16px; }
        .info-table { width: 100%; border-collapse: collapse; margin-top: 10px; margin-bottom: 20px; }
        .info-table td { padding: 12px 14px; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
        .info-table td.label { width: 35%; font-weight: 600; color: #64748b; background-color: #f8fafc; }
        .info-table td.value { width: 65%; font-weight: 600; color: #0f172a; }
        .content-box { background: #f8fafc; border-left: 4px solid #1D58BB; padding: 14px 16px; border-radius: 6px; font-size: 14px; line-height: 1.5; color: #334155; margin-top: 6px; }
        .btn-call { display: inline-block; background: #1D58BB; color: #ffffff !important; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-weight: 600; font-size: 13.5px; margin-right: 10px; }
        .btn-mail { display: inline-block; background: #0284c7; color: #ffffff !important; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-weight: 600; font-size: 13.5px; }
        .mail-footer { background-color: #f1f5f9; padding: 18px 24px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; }
      </style>
    </head>
    <body>
      <div class="mail-card">
        <div class="mail-header">
          <h1>3AHOME VIỆT NAM</h1>
          <p>Hệ thống BMS &amp; Giải pháp Điều khiển Thông minh Smart IoT</p>
        </div>
        <div class="mail-body">
          <div class="tag-badge">🔔 ĐƠN TƯ VẤN MỚI</div>
          <h2 style="font-size: 17px; margin: 0 0 16px 0; color: #0f172a;">Thông tin khách hàng đăng ký</h2>
          
          <table class="info-table">
            <tr>
              <td class="label">Họ và tên:</td>
              <td class="value" style="font-size: 15px; color: #1D58BB;">${full_name}</td>
            </tr>
            <tr>
              <td class="label">Số điện thoại:</td>
              <td class="value"><a href="tel:${phone}" style="color: #1D58BB; text-decoration: none;">${phone}</a></td>
            </tr>
            <tr>
              <td class="label">Email liên hệ:</td>
              <td class="value"><a href="mailto:${email}" style="color: #0284c7; text-decoration: none;">${email}</a></td>
            </tr>
            <tr>
              <td class="label">Loại nhu cầu:</td>
              <td class="value"><span style="background: #eff6ff; color: #1d4ed8; padding: 3px 8px; border-radius: 6px;">${type}</span></td>
            </tr>
            <tr>
              <td class="label">Nguồn gửi:</td>
              <td class="value">${source}</td>
            </tr>
            <tr>
              <td class="label">Thời gian tiếp nhận:</td>
              <td class="value">${submitTime}</td>
            </tr>
          </table>

          <div style="font-weight: 600; color: #64748b; font-size: 13.5px; margin-bottom: 6px;">Nội dung yêu cầu chi tiết:</div>
          <div class="content-box">
            ${content ? content.replace(/\n/g, '<br/>') : '<em>(Không có nội dung mô tả chi tiết)</em>'}
          </div>

          <div style="margin-top: 24px; text-align: center;">
            <a href="tel:${phone}" class="btn-call">📞 Gọi ngay: ${phone}</a>
            <a href="mailto:${email}?subject=3AHOME - Phản hồi yêu cầu tư vấn" class="btn-mail">✉️ Gửi email cho khách</a>
          </div>
        </div>

        <div class="mail-footer">
          Email này được gửi tự động từ hệ thống máy chủ <strong>3AHOME Vietnam</strong>.<br/>
          Trụ sở: 698 Nguyễn Lương Bằng, P. Hoà Hiệp Nam, Q. Liên Chiểu, TP. Đà Nẵng.<br/>
          Website: <a href="https://3ahome.vn" style="color: #1D58BB;">https://3ahome.vn</a>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    const info = await mailTransporter.sendMail({
      from: `"${process.env.SMTP_FROM_NAME || '3AHOME Vietnam'}" <${smtpUser}>`,
      to: smtpUser,
      cc: notifyCc,
      subject: subject,
      html: htmlContent
    });
    console.log(`✅ [Nodemailer] Đã gửi email thông báo thành công tới ${smtpUser} và CC ${notifyCc}! MessageId: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ [Nodemailer] Lỗi khi gửi email qua Gmail SMTP:', error);
    return { success: false, error: error.message };
  }
}
