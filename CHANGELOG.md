# 📋 Changelog — Nexus Autopilot

All notable changes to the **Nexus Autopilot for Antigravity** extension will be documented in this file.

---

## [1.1.9] - 2026-08-21

### ✨ Added & Restored
- **Dedicated Dashboard Status Bar Button**: เพิ่มปุ่ม `$(dashboard) Nexus Dashboard` สีฟ้า Neon Cyan บน Status Bar (มุมขวาล่าง) คลิกเปิดแดชบอร์ดได้ทันที
- **New Dashboard Command**: เพิ่มคำสั่ง `Nexus Autopilot: เปิดแดชบอร์ด & การตั้งค่า (Open Dashboard)` ใน Command Palette (`Ctrl+Shift+P`)
- **Direct HTTP Web Dashboard**: เข้าถึงแดชบอร์ดผ่าน Web Browser ได้โดยตรงที่ `http://127.0.0.1:48787/` หรือ `/dashboard` พร้อม REST APIs รองรับการตั้งค่าผ่านเบราว์เซอร์
- **Dual Webview / Standalone Browser Sync**: แดชบอร์ดทำงานได้ทั้งแบบ Webview Panel ใน IDE และแบบ Web App บนเบราว์เซอร์ภายนอก พร้อม Real-time Auto-refresh
- **Safe UTF-8 Unicode Base64 Decoding**: ใช้ `TextDecoder` แทน `escape()` ป้องกันข้อผิดพลาดในการโหลดภาษาไทยและ Emoji ใน Dashboard

### 🐛 Fixed & Optimized
- **แก้ปัญหาการพิมพ์ `/` แล้วเกิด Auto Tab (Zero Focus-Stealing Engine)**:
  - แก้ไขบั๊กเมื่อผู้ใช้พิมพ์เครื่องหมาย Slash (`/`) ใน Editor หรือช่อง Input แล้วตัว Suggestion/AutoComplete ถูกแย่ง Focus จนเกิดการกด Tab/Select แทรกโดยไม่ตั้งใจ
  - ตัดการเรียก `el.focus()` ออกจากระบบคลิกอัตโนมัติทั้งหมด 100% เพื่อไม่ให้รบกวนเคอร์เซอร์ของผู้ใช้
  - กรองข้าม Monaco Suggest Widget, Context View, Merge Editor, Quick Input Widget และ Statusbar/Menubar อย่างเข้มงวด

### ⚠️ Known Issues / บั๊กที่ยังพบ & อยู่ระหว่างการพัฒนา
- **Submit Command Logging Limitation**:
  - ยังมีข้อจำกัด/บั๊กในการดักจับและบันทึกข้อความคำสั่ง (Command Context) จากปุ่ม `Submit` โดยระบบยังไม่สามารถดึงและบันทึกรายละเอียดคำสั่งที่ถูก Submit ลงในตารางประวัติกิจกรรม (Activity Log) ได้อย่างสมบูรณ์ ซึ่งกำลังอยู่ในระหว่างการพัฒนาและจะได้รับการแก้ไขในเวอร์ชันถัดไป

---

## [1.1.8] - 2026-08-21

### ✨ Added
- **Chat-Aware Direct Approval**: รองรับการคลิกปุ่มอัตโนมัติในหน้าต่างแชต Antigravity ทันทีสำหรับปุ่มเดี่ยวที่ไม่มีปุ่ม Cancel หรือ Reject อยู่ข้างๆ
- **Dual-Transport Click Logging**: ระบบส่งบันทึกกิจกรรมแบบ 2 ทาง (Instant Non-blocking POST + Periodic Polling Queue Buffer) ป้องกัน Log ตกหล่น 100% แม้มีการสลับพอร์ต
- **Command & Question Context Extraction**: ดึงคำสั่งโค้ดและคำถามย่อ (`➔ npm test`, etc.) แสดงในตารางบันทึกกิจกรรมแบบ Real-time
- **Dynamic Version Header**: ดึงเลขเวอร์ชันปัจจุบันจาก `package.json` แสดงผลบน Webview Dashboard อัตโนมัติ

### ⚡ Changed & Optimized
- **Word-Boundary Pattern Matcher**: ปรับปรุง Pattern Matching ให้แม่นยำด้วย Word Boundary ป้องกัน False Positive กับคำนำหน้าอย่าง `running` หรือ `allowance`
- **Air-Tight Monaco Editor Isolation**: กรองข้าม Monaco Suggest Widget, Context View, Merge Editor, Quick Input Widget และ Titlebar/Statusbar อย่างเข้มงวด

---

## [1.1.7] - 2026-08-21
- **Focus Isolation**: เริ่มตัดการแย่ง Focus จาก Suggest Widget ใน Monaco Editor
- **Selector Expansion**: ขยายการค้นหาปุ่มในฝั่ง Chat Panel

---

## [1.1.4] - 2026-08-20
- **Live Click Log**: เพิ่มหน้าต่างดูประวัติการคลิกแบบ Real-time
- **Multi-Instance Support**: รองรับการค้นหาพอร์ตแบบ Dynamic (48787-48850)
- **Thai Dashboard**: แดชบอร์ดภาษาไทย 100%
