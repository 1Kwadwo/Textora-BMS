#!/usr/bin/env python3
"""
KebSEND Developer Pack PDF Generator
Produces a high-quality, professional 2-page developer integration pack.
"""
from fpdf import FPDF
import os

class KebsendDevPackPDF(FPDF):
    def __init__(self):
        super().__init__(orientation="P", unit="mm", format="A4")
        self.set_auto_page_break(auto=True, margin=18)
        self.set_margins(14, 14, 14)

    def footer(self):
        self.set_y(-14)
        self.set_font("helvetica", "", 8)
        self.set_text_color(148, 163, 184) # slate-400
        self.cell(90, 8, f"KebSEND Developer Documentation  |  Page {self.page_no()}", 0, 0, "L")
        
        self.set_font("helvetica", "B", 9)
        self.set_text_color(37, 99, 235) # royal blue
        self.cell(92, 8, "KebSEND developer pack", 0, 0, "R")

    def draw_header_banner(self):
        # Banner container
        self.set_fill_color(15, 23, 42) # #0f172a
        self.rect(14, 14, 182, 28, "F")
        
        # Accent left stripe
        self.set_fill_color(37, 99, 235) # #2563eb
        self.rect(14, 14, 4, 28, "F")

        # Title
        self.set_xy(22, 17)
        self.set_font("helvetica", "B", 18)
        self.set_text_color(255, 255, 255)
        self.cell(70, 8, "KebSEND", 0, 0, "L")

        # Version Pill
        self.set_fill_color(37, 99, 235)
        self.set_font("helvetica", "B", 8)
        self.rect(56, 18, 22, 6, "F")
        self.set_xy(56, 18)
        self.cell(22, 6, "REST API v1", 0, 0, "C")

        # Subtitle
        self.set_xy(22, 26)
        self.set_font("helvetica", "", 9.5)
        self.set_text_color(148, 163, 184)
        self.cell(100, 6, "Official Developer Integration Quickstart & Endpoint Reference", 0, 0, "L")

        # Right side metadata
        self.set_xy(125, 17)
        self.set_font("helvetica", "", 8)
        self.set_text_color(203, 213, 225)
        self.cell(65, 5, "Environment: Production Live", 0, 2, "R")
        self.cell(65, 5, "Format: JSON / HTTPS", 0, 2, "R")
        self.cell(65, 5, "Support: Ghana & International SMS", 0, 0, "R")

        self.set_y(46)

    def section_title(self, title):
        self.set_font("helvetica", "B", 11)
        self.set_text_color(15, 23, 42)
        
        # small blue square icon
        self.set_fill_color(37, 99, 235)
        self.rect(self.get_x(), self.get_y() + 1, 3, 4, "F")
        self.set_x(self.get_x() + 5)
        self.cell(0, 6, title, 0, 1, "L")
        self.ln(1)

    def draw_code_box(self, code_text):
        lines = code_text.strip().split("\n")
        box_height = len(lines) * 4.4 + 4
        
        self.set_fill_color(15, 23, 42)
        self.set_draw_color(30, 41, 59)
        x = self.get_x()
        y = self.get_y()
        self.rect(x, y, 182, box_height, "FD")
        
        self.set_xy(x + 3, y + 2)
        self.set_font("courier", "", 8)
        self.set_text_color(241, 245, 249)
        
        for line in lines:
            if line.startswith("#"):
                self.set_text_color(148, 163, 184) # comments gray
            elif any(k in line for k in ['"ok":', '"balance":', '"status":', '"data":', '"remaining_balance":']):
                self.set_text_color(56, 189, 248) # keys cyan
            else:
                self.set_text_color(241, 245, 249)
            self.cell(176, 4.4, line, 0, 2, "L")
            self.set_x(x + 3)
        self.set_y(y + box_height + 2)


def generate_dev_pack():
    pdf = KebsendDevPackPDF()
    
    # =========================================================================
    # PAGE 1: Base URLs, Auth & Core Endpoints
    # =========================================================================
    pdf.add_page()
    pdf.draw_header_banner()

    # SECTION 1: BASE URLS
    pdf.section_title("1. Base URLs - Choose According to Your API Key")
    pdf.set_font("helvetica", "", 8.8)
    pdf.set_text_color(51, 65, 85)
    pdf.multi_cell(182, 4.5, "KebSEND operates two dedicated production API gateways. Check the prefix of your API key to determine which endpoint URL to target:")
    pdf.ln(1.5)

    # Gateway 1 Box (Web Dashboard)
    y_start = pdf.get_y()
    pdf.set_fill_color(248, 250, 252)
    pdf.set_draw_color(203, 213, 225)
    pdf.rect(14, y_start, 88, 23, "FD")
    
    pdf.set_xy(17, y_start + 2.5)
    pdf.set_fill_color(219, 234, 254)
    pdf.rect(17, y_start + 2.5, 34, 4.5, "F")
    pdf.set_font("helvetica", "B", 7)
    pdf.set_text_color(29, 78, 216)
    pdf.cell(34, 4.5, "WEB PORTAL KEYS", 0, 2, "C")
    
    pdf.set_x(17)
    pdf.set_font("courier", "B", 7.6)
    pdf.set_text_color(15, 23, 42)
    pdf.cell(82, 5, "https://textora-bms-website.onrender.com", 0, 2, "L")
    
    pdf.set_x(17)
    pdf.set_font("helvetica", "", 7.5)
    pdf.set_text_color(100, 116, 139)
    pdf.cell(82, 4.5, "For API keys starting with ksnd_live_...", 0, 0, "L")

    # Gateway 2 Box (Bot Gateway)
    pdf.set_fill_color(248, 250, 252)
    pdf.rect(108, y_start, 88, 23, "FD")
    
    pdf.set_xy(111, y_start + 2.5)
    pdf.set_fill_color(220, 252, 231)
    pdf.rect(111, y_start + 2.5, 30, 4.5, "F")
    pdf.set_font("helvetica", "B", 7)
    pdf.set_text_color(22, 101, 52)
    pdf.cell(30, 4.5, "BOT / EXT KEYS", 0, 2, "C")
    
    pdf.set_x(111)
    pdf.set_font("courier", "B", 7.6)
    pdf.set_text_color(15, 23, 42)
    pdf.cell(82, 5, "https://textora-bmsv2.onrender.com", 0, 2, "L")
    
    pdf.set_x(111)
    pdf.set_font("helvetica", "", 7.5)
    pdf.set_text_color(100, 116, 139)
    pdf.cell(82, 4.5, "For API keys starting with txt_...", 0, 0, "L")

    pdf.set_y(y_start + 26)

    # SECTION 2: AUTHENTICATION
    pdf.section_title("2. Request Headers & Authentication")
    pdf.set_font("helvetica", "", 8.5)
    pdf.set_text_color(51, 65, 85)
    pdf.multi_cell(182, 4.2, "Authenticate all requests by including your secret key in either header:")
    pdf.ln(1)

    # Headers table
    pdf.set_fill_color(241, 245, 249)
    pdf.set_font("helvetica", "B", 8)
    pdf.set_text_color(15, 23, 42)
    pdf.cell(36, 6, "Header", 1, 0, "L", True)
    pdf.cell(64, 6, "Example Value", 1, 0, "L", True)
    pdf.cell(82, 6, "Usage & Notes", 1, 1, "L", True)

    pdf.set_font("helvetica", "", 8)
    pdf.cell(36, 6, " x-api-key", 1, 0, "L")
    pdf.set_font("courier", "", 7.5)
    pdf.cell(64, 6, " x-api-key: YOUR_API_KEY", 1, 0, "L")
    pdf.set_font("helvetica", "", 7.5)
    pdf.cell(82, 6, " Recommended standard custom header", 1, 1, "L")

    pdf.set_font("helvetica", "", 8)
    pdf.cell(36, 6, " Authorization", 1, 0, "L")
    pdf.set_font("courier", "", 7.5)
    pdf.cell(64, 6, " Bearer YOUR_API_KEY", 1, 0, "L")
    pdf.set_font("helvetica", "", 7.5)
    pdf.cell(82, 6, " RFC 6750 Bearer token authorization format", 1, 1, "L")

    pdf.set_font("helvetica", "", 8)
    pdf.cell(36, 6, " Content-Type", 1, 0, "L")
    pdf.set_font("courier", "", 7.5)
    pdf.cell(64, 6, " application/json", 1, 0, "L")
    pdf.set_font("helvetica", "", 7.5)
    pdf.cell(82, 6, " Required for all POST requests", 1, 1, "L")

    pdf.ln(3)

    # SECTION 3: BALANCE ENDPOINT
    pdf.section_title("3. Check Account Credit Balance")
    pdf.set_font("courier", "B", 9)
    pdf.set_text_color(22, 101, 52)
    pdf.cell(16, 5, "GET", 0, 0, "L")
    pdf.set_text_color(15, 23, 42)
    pdf.cell(100, 5, "/api/v1/balance", 0, 1, "L")
    pdf.set_font("helvetica", "", 8)
    pdf.set_text_color(100, 116, 139)
    pdf.cell(182, 4.5, "Returns remaining SMS units and registered account email address.", 0, 1, "L")
    
    code_balance = """# Terminal cURL Command
curl -X GET "https://textora-bms-website.onrender.com/api/v1/balance" \\
  -H "x-api-key: YOUR_API_KEY"

# Response (200 OK)
{ "ok": true, "balance": 450, "user_email": "developer@company.com" }"""
    pdf.draw_code_box(code_balance)
    pdf.ln(1)

    # SECTION 4: SENDER IDS
    pdf.section_title("4. Approved Sender IDs List")
    pdf.set_font("courier", "B", 9)
    pdf.set_text_color(22, 101, 52)
    pdf.cell(16, 5, "GET", 0, 0, "L")
    pdf.set_text_color(15, 23, 42)
    pdf.cell(100, 5, "/api/v1/sender-ids", 0, 1, "L")
    
    code_sender_ids = """# Terminal cURL Command
curl -X GET "https://textora-bms-website.onrender.com/api/v1/sender-ids" \\
  -H "x-api-key: YOUR_API_KEY"

# Response (200 OK)
{ "ok": true, "senderIds": ["TXTORA", "MYSHOP"] }"""
    pdf.draw_code_box(code_sender_ids)

    # =========================================================================
    # PAGE 2: Send SMS, Code Examples & Status Codes
    # =========================================================================
    pdf.add_page()
    
    # SECTION 5: SEND SMS
    pdf.section_title("5. Send SMS (Single or Multi-Recipient)")
    pdf.set_font("courier", "B", 9)
    pdf.set_text_color(29, 78, 216)
    pdf.cell(16, 5, "POST", 0, 0, "L")
    pdf.set_text_color(15, 23, 42)
    pdf.cell(100, 5, "/api/v1/send-sms", 0, 1, "L")
    pdf.set_font("helvetica", "", 8)
    pdf.set_text_color(100, 116, 139)
    pdf.cell(182, 4.5, "Dispatches SMS to Ghanaian and international mobile numbers. Debits credit units automatically.", 0, 1, "L")

    # Parameters Table
    pdf.set_fill_color(241, 245, 249)
    pdf.set_font("helvetica", "B", 8)
    pdf.set_text_color(15, 23, 42)
    pdf.cell(24, 6, "Field", 1, 0, "L", True)
    pdf.cell(24, 6, "Type", 1, 0, "L", True)
    pdf.cell(22, 6, "Required", 1, 0, "L", True)
    pdf.cell(112, 6, "Description & Format", 1, 1, "L", True)

    pdf.set_font("courier", "", 7.5)
    pdf.cell(24, 5.5, " to", 1, 0, "L")
    pdf.set_font("helvetica", "", 7.5)
    pdf.cell(24, 5.5, " String | Array", 1, 0, "L")
    pdf.set_font("helvetica", "B", 7.5)
    pdf.set_text_color(220, 38, 38)
    pdf.cell(22, 5.5, " YES", 1, 0, "L")
    pdf.set_font("helvetica", "", 7.5)
    pdf.set_text_color(51, 65, 85)
    pdf.cell(112, 5.5, " '0244123456' or ['0244123456', '0501122334']. Ghana & intl formats.", 1, 1, "L")

    pdf.set_font("courier", "", 7.5)
    pdf.cell(24, 5.5, " message", 1, 0, "L")
    pdf.set_font("helvetica", "", 7.5)
    pdf.cell(24, 5.5, " String", 1, 0, "L")
    pdf.set_font("helvetica", "B", 7.5)
    pdf.set_text_color(220, 38, 38)
    pdf.cell(22, 5.5, " YES", 1, 0, "L")
    pdf.set_font("helvetica", "", 7.5)
    pdf.set_text_color(51, 65, 85)
    pdf.cell(112, 5.5, " SMS body. 160 GSM chars = 1 credit unit; 70 chars for Unicode.", 1, 1, "L")

    pdf.set_font("courier", "", 7.5)
    pdf.cell(24, 5.5, " senderId", 1, 0, "L")
    pdf.set_font("helvetica", "", 7.5)
    pdf.cell(24, 5.5, " String", 1, 0, "L")
    pdf.set_font("helvetica", "", 7.5)
    pdf.set_text_color(100, 116, 139)
    pdf.cell(22, 5.5, " Optional", 1, 0, "L")
    pdf.set_font("helvetica", "", 7.5)
    pdf.set_text_color(51, 65, 85)
    pdf.cell(112, 5.5, " Branded Sender ID (default: TXTORA). Must be approved on account.", 1, 1, "L")

    code_send_sms = """# Dispatch Request Example
curl -X POST "https://textora-bms-website.onrender.com/api/v1/send-sms" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "to": ["0244123456", "0501122334"],
    "message": "Your verification code is 482910. Do not share this code.",
    "senderId": "TXTORA"
  }'

# Success Response (200 OK)
{
  "ok": true,
  "total_units_debited": 2,
  "remaining_balance": 448,
  "data": { "status": "success", "recipients_count": 2 }
}"""
    pdf.draw_code_box(code_send_sms)
    pdf.ln(1)

    # SECTION 6: CODE EXAMPLES
    pdf.section_title("6. Production Code Snippets")

    # Node.js
    pdf.set_font("helvetica", "B", 8)
    pdf.set_text_color(15, 23, 42)
    pdf.cell(0, 4.5, "Node.js (Modern Fetch):", 0, 1, "L")
    
    code_nodejs = """const res = await fetch("https://textora-bms-website.onrender.com/api/v1/send-sms", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": process.env.KEBSEND_API_KEY },
  body: JSON.stringify({ to: "0244123456", message: "OTP: 918234", senderId: "TXTORA" })
});
const data = await res.json();
console.log("Delivery status:", data);"""
    pdf.draw_code_box(code_nodejs)

    # Python
    pdf.set_font("helvetica", "B", 8)
    pdf.set_text_color(15, 23, 42)
    pdf.cell(0, 4.5, "Python 3 (Requests):", 0, 1, "L")
    
    code_python = """import requests

url = "https://textora-bms-website.onrender.com/api/v1/send-sms"
headers = { "Content-Type": "application/json", "x-api-key": "YOUR_API_KEY" }
payload = { "to": ["0244123456"], "message": "Order #482 confirmed!", "senderId": "TXTORA" }

response = requests.post(url, json=payload, headers=headers)
print(response.json())"""
    pdf.draw_code_box(code_python)
    pdf.ln(1)

    # SECTION 7: STATUS CODES TABLE
    pdf.section_title("7. HTTP Status Codes & Error Reference")
    
    pdf.set_fill_color(241, 245, 249)
    pdf.set_font("helvetica", "B", 8)
    pdf.set_text_color(15, 23, 42)
    pdf.cell(20, 5, "HTTP Code", 1, 0, "L", True)
    pdf.cell(50, 5, "API Response Message", 1, 0, "L", True)
    pdf.cell(112, 5, "Meaning / Recommended Action", 1, 1, "L", True)

    rows = [
        (" 200 OK", " \"ok\": true", "SMS dispatched to telco carriers; units successfully deducted."),
        (" 400 Bad Req", " Missing \"to\" or \"message\"", "Payload validation failed; verify JSON keys and recipient phone formats."),
        (" 401 Unauth", " Missing or invalid API key", "Key is absent, invalid, or being sent to the incorrect Base URL."),
        (" 402 Payment", " Insufficient balance", "Developer wallet credits exhausted. Top up via dashboard or recharge API."),
        (" 429 Too Many", " Rate limit exceeded", "Rate limit is 120 calls/minute. Throttle requests or batch numbers in arrays.")
    ]

    for code, msg, desc in rows:
        pdf.set_font("helvetica", "B" if "200" in code else "", 7.5)
        if "200" in code:
            pdf.set_text_color(22, 101, 52)
        elif "400" in code or "401" in code:
            pdf.set_text_color(220, 38, 38)
        else:
            pdf.set_text_color(124, 58, 237)
        pdf.cell(20, 5, code, 1, 0, "L")
        
        pdf.set_font("courier", "", 7.2)
        pdf.set_text_color(15, 23, 42)
        pdf.cell(50, 5, msg, 1, 0, "L")
        
        pdf.set_font("helvetica", "", 7.2)
        pdf.set_text_color(51, 65, 85)
        pdf.cell(112, 5, desc, 1, 1, "L")

    # Output paths
    out_root = "/Users/harrisonessuakwadwobraimah/Downloads/textora/KebSEND_Developer_Pack.pdf"
    out_public = "/Users/harrisonessuakwadwobraimah/Downloads/textora/web/public/KebSEND_Developer_Pack.pdf"
    
    pdf.output(out_root)
    pdf.output(out_public)
    print(f"Successfully generated:\n- {out_root}\n- {out_public}")

if __name__ == "__main__":
    generate_dev_pack()

