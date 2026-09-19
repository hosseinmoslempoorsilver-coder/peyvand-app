// سرور «پیوند» — پیام‌رسان مجموعه شهید احمدی روشن
// سرور ساده با Express؛ پیام‌ها و فهرست تیم‌ها در یک فایل JSON نگه داشته می‌شود.

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data", "store.json");
const MAX_MESSAGES_PER_ROOM = 500;
const MAX_TEXT_LENGTH = 2000;
const MAX_NAME_LENGTH = 40;
const MAX_TEAM_NAME_LENGTH = 60;
const MAX_TEAMS = 300;

// اتاق‌های ثابت: چهار اتاق عمومی مجموعه + اتاق هسته سخت
const FIXED_ROOMS = ["general", "announcements", "classes", "events", "core"];

function isValidRoom(room) {
  if (typeof room !== "string") return false;
  if (FIXED_ROOMS.includes(room)) return true;
  return /^team:[A-Za-z0-9%_.\-]{1,150}$/.test(room);
}

// ---------- ذخیره‌سازی ساده در فایل ----------
function loadStore() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      messages: parsed.messages || {},
      teams: parsed.teams || {},
    };
  } catch (e) {
    return { messages: {}, teams: {} };
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store), "utf8");
}

let store = loadStore();
for (const room of FIXED_ROOMS) {
  if (!Array.isArray(store.messages[room])) store.messages[room] = [];
}

// ---------- میان‌افزارها ----------
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

// جلوگیری ساده از سیل درخواست
const rateMap = new Map();
function isRateLimited(ip, max) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const entry = rateMap.get(ip) || [];
  const recent = entry.filter((t) => now - t < windowMs);
  recent.push(now);
  rateMap.set(ip, recent);
  return recent.length > (max || 20);
}

function sanitizeText(input, maxLen) {
  if (typeof input !== "string") return "";
  return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, maxLen);
}

function normalizeTeamName(name) {
  return sanitizeText(name, MAX_TEAM_NAME_LENGTH).replace(/\s+/g, " ");
}

// ---------- تیم‌ها ----------

// ثبت یا پیدا کردن اتاق یک تیم بر اساس نامش (در مرحله‌ی ورود صدا زده می‌شود)
app.post("/api/teams/resolve", (req, res) => {
  const ip = req.ip || "unknown";
  if (isRateLimited(ip, 30)) return res.status(429).json({ error: "rate_limited" });

  const name = normalizeTeamName(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: "empty_name" });

  const roomId = "team:" + encodeURIComponent(name);
  if (!store.teams[roomId]) {
    if (Object.keys(store.teams).length >= MAX_TEAMS) {
      return res.status(409).json({ error: "too_many_teams" });
    }
    store.teams[roomId] = { name, createdAt: Date.now() };
    store.messages[roomId] = [];
    saveStore(store);
  }
  res.json({ roomId, name: store.teams[roomId].name });
});

// فهرست همه‌ی تیم‌ها — فقط برای نمایش به مدیر استفاده می‌شود
app.get("/api/teams", (req, res) => {
  const list = Object.keys(store.teams)
    .map((roomId) => ({ roomId, name: store.teams[roomId].name }))
    .sort((a, b) => a.name.localeCompare(b.name, "fa"));
  res.json({ teams: list });
});

// ---------- پیام‌ها ----------

app.get("/api/messages", (req, res) => {
  const room = req.query.room;
  if (!isValidRoom(room)) return res.status(400).json({ error: "invalid_room" });
  if (!store.messages[room]) store.messages[room] = [];

  const after = Number(req.query.after) || 0;
  const all = store.messages[room];
  const messages = after ? all.filter((m) => m.createdAt > after) : all.slice(-200);
  res.json({ messages });
});

app.post("/api/messages", (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  if (isRateLimited(ip, 20)) return res.status(429).json({ error: "rate_limited" });

  const room = req.body && req.body.room;
  const text = sanitizeText(req.body && req.body.text, MAX_TEXT_LENGTH);
  const senderName = sanitizeText(req.body && req.body.senderName, MAX_NAME_LENGTH) || "بدون نام";
  const senderId = sanitizeText(req.body && req.body.senderId, 64);
  const roleRaw = sanitizeText(req.body && req.body.role, 10);
  const role = ["admin", "core", "team"].includes(roleRaw) ? roleRaw : "member";

  if (!isValidRoom(room)) return res.status(400).json({ error: "invalid_room" });
  if (!text) return res.status(400).json({ error: "empty_text" });
  if (!senderId) return res.status(400).json({ error: "missing_sender" });
  if (!store.messages[room]) store.messages[room] = [];

  const message = {
    id: "m" + Date.now() + Math.random().toString(36).slice(2, 8),
    room,
    senderId,
    senderName,
    role,
    text,
    createdAt: Date.now(),
  };

  store.messages[room].push(message);
  if (store.messages[room].length > MAX_MESSAGES_PER_ROOM) {
    store.messages[room] = store.messages[room].slice(store.messages[room].length - MAX_MESSAGES_PER_ROOM);
  }
  saveStore(store);

  res.status(201).json({ message });
});

// ---------- نصب: کد QR و صفحه‌ی راهنما ----------

app.get("/qr.png", async (req, res) => {
  try {
    const QRCode = require("qrcode");
    const url = req.protocol + "://" + req.get("host") + "/";
    const buffer = await QRCode.toBuffer(url, {
      width: 480,
      margin: 2,
      color: { dark: "#23303D", light: "#FBFAF7" },
    });
    res.type("png").send(buffer);
  } catch (e) {
    res.status(500).send("خطا در ساخت QR");
  }
});

app.get("/install", (req, res) => {
  const url = req.protocol + "://" + req.get("host") + "/";
  res.type("html").send(`<!DOCTYPE html>
<html lang="fa" dir="rtl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>نصب پیوند</title>
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@500;700;800&display=swap" rel="stylesheet">
<style>
  body{font-family:'Vazirmatn',sans-serif;background:#FBFAF7;color:#23303D;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center;}
  .card{max-width:380px;}
  .mark{width:56px;height:56px;border-radius:16px;background:linear-gradient(155deg,#3E5C50,#23303D 130%);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;box-shadow:0 4px 18px rgba(35,48,61,0.15);font-size:26px;}
  h1{font-size:20px;margin:0 0 6px;font-weight:800;}
  p{color:#6B7684;font-size:14px;line-height:1.8;margin:0 0 20px;}
  img{width:220px;height:220px;border-radius:16px;border:1px solid #E4DFD3;background:#fff;padding:12px;box-shadow:0 4px 18px rgba(35,48,61,0.08);}
  .steps{text-align:right;background:#fff;border:1px solid #E4DFD3;border-radius:14px;padding:16px 20px;margin-top:20px;font-size:13.5px;line-height:2;}
  .link{margin-top:16px;font-size:13px;color:#3E5C50;word-break:break-all;}
</style></head>
<body><div class="card">
  <div class="mark">🪢</div>
  <h1>پیوند</h1>
  <p>پیام‌رسان مجموعه شهید احمدی روشن — دوربین گوشی را روی این کد بگیرید</p>
  <img src="/qr.png" alt="کد QR ورود به پیوند">
  <div class="steps">
    ۱. دوربین گوشی را باز کنید و روی کد بگیرید<br>
    ۲. لینکی که بالا می‌آید را لمس کنید<br>
    ۳. صفحه که باز شد، از منوی مرورگر «Add to Home screen» را بزنید
  </div>
  <div class="link">${url}</div>
</div></body></html>`);
});

app.get("/health", (req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log("پیوند روی پورت " + PORT + " در حال اجراست");
});
