const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const initSqlJs = require("sql.js");
const nodemailer = require("nodemailer");

const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@catalogo.local").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const APP_URL = process.env.APP_URL || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "app.db");
let db;

function wrapDb(raw) {
  function persist() {
    fs.writeFileSync(DB_FILE, Buffer.from(raw.export()));
  }
  return {
    persist,
    exec(sql) {
      raw.exec(sql);
      persist();
    },
    prepare(sql) {
      return {
        get(...params) {
          const stmt = raw.prepare(sql);
          if (params.length) stmt.bind(params);
          const row = stmt.step() ? stmt.getAsObject() : undefined;
          stmt.free();
          return row;
        },
        all(...params) {
          const stmt = raw.prepare(sql);
          if (params.length) stmt.bind(params);
          const rows = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          stmt.free();
          return rows;
        },
        run(...params) {
          raw.run(sql, params);
          persist();
          const r = raw.exec("SELECT last_insert_rowid() AS id");
          const lastInsertRowid = r.length && r[0].values.length ? r[0].values[0][0] : 0;
          return { lastInsertRowid };
        }
      };
    }
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  plan TEXT NOT NULL DEFAULT 'free',
  stripe_customer TEXT,
  stripe_subscription TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  exp INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS resets (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  exp INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS catalogs (
  user_id INTEGER PRIMARY KEY,
  title TEXT,
  period TEXT,
  layout TEXT,
  products TEXT,
  updated_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`;

function hashPass(pass) {
  return bcrypt.hashSync(String(pass), 10);
}
function checkPass(pass, hash) {
  return bcrypt.compareSync(String(pass), String(hash || ""));
}
function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}
function emailOk(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail(v));
}
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    user: row.user,
    email: row.email,
    role: row.role,
    plan: row.plan || "free"
  };
}

function seedAdmin() {
  const existingAdmin = db.prepare("SELECT id FROM users WHERE user = ? OR email = ?").get(ADMIN_USER, ADMIN_EMAIL);
  if (!existingAdmin) {
    db.prepare("INSERT INTO users (user,email,pass,role,plan,created_at) VALUES (?,?,?,?,?,?)").run(
      ADMIN_USER,
      ADMIN_EMAIL,
      hashPass(ADMIN_PASSWORD),
      "admin",
      "pro",
      new Date().toISOString()
    );
  } else {
    db.prepare("UPDATE users SET role='admin', plan='pro' WHERE id=?").run(existingAdmin.id);
  }
}

async function initDb() {
  const SQL = await initSqlJs();
  const raw = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
  db = wrapDb(raw);
  db.exec(SCHEMA);
  seedAdmin();
}

function mailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_PORT || "587") === "465",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function originFrom(req) {
  if (APP_URL) return APP_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return proto + "://" + host;
}

const app = express();
app.set("trust proxy", 1);
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "8mb" }));
app.use(cookieParser(SESSION_SECRET));

function setSession(res, token) {
  res.cookie("sid", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/"
  });
}
function clearSession(res) {
  res.clearCookie("sid", { path: "/" });
}
function getUser(req) {
  const token = req.cookies.sid;
  if (!token) return null;
  const sess = db.prepare("SELECT s.user_id, s.exp FROM sessions s WHERE s.token=?").get(token);
  if (!sess || sess.exp < Date.now()) {
    if (sess) db.prepare("DELETE FROM sessions WHERE token=?").run(token);
    return null;
  }
  return db.prepare("SELECT * FROM users WHERE id=?").get(sess.user_id);
}
function auth(req, res, next) {
  req.user = getUser(req);
  if (!req.user) return res.status(401).json({ error: "Nao autenticado" });
  next();
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "Acesso admin" });
  next();
}

app.post("/api/register", (req, res) => {
  const user = String(req.body.user || "").trim();
  const email = normEmail(req.body.email);
  const pass = String(req.body.pass || req.body.password || "");
  if (!user || !email || !pass) return res.status(400).json({ error: "Informe usuario, e-mail e senha." });
  if (/\s/.test(user)) return res.status(400).json({ error: "Usuario sem espacos." });
  if (!emailOk(email)) return res.status(400).json({ error: "E-mail invalido." });
  if (pass.length < 4) return res.status(400).json({ error: "Senha muito curta." });
  const exists = db.prepare("SELECT id FROM users WHERE lower(user)=? OR email=?").get(user.toLowerCase(), email);
  if (exists) return res.status(409).json({ error: "Usuario ou e-mail ja cadastrado." });
  const info = db.prepare("INSERT INTO users (user,email,pass,role,plan,created_at) VALUES (?,?,?,?,?,?)").run(
    user, email, hashPass(pass), "user", "free", new Date().toISOString()
  );
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO sessions (token,user_id,exp) VALUES (?,?,?)").run(token, info.lastInsertRowid, Date.now() + 30 * 864e5);
  setSession(res, token);
  const row = db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
  res.json({ user: publicUser(row) });
});

app.post("/api/login", (req, res) => {
  const login = String(req.body.login || req.body.user || "").trim().toLowerCase();
  const pass = String(req.body.pass || req.body.password || "");
  const row = db.prepare("SELECT * FROM users WHERE lower(user)=? OR email=?").get(login, login);
  if (!row || !checkPass(pass, row.pass)) return res.status(401).json({ error: "Usuario, e-mail ou senha invalidos." });
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO sessions (token,user_id,exp) VALUES (?,?,?)").run(token, row.id, Date.now() + 30 * 864e5);
  setSession(res, token);
  res.json({ user: publicUser(row) });
});

app.post("/api/logout", auth, (req, res) => {
  const token = req.cookies.sid;
  if (token) db.prepare("DELETE FROM sessions WHERE token=?").run(token);
  clearSession(res);
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ user: publicUser(req.user), billingReady: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID) });
});

app.post("/api/password", auth, (req, res) => {
  const atual = String(req.body.atual || "");
  const nova = String(req.body.nova || "");
  if (!checkPass(atual, req.user.pass)) return res.status(400).json({ error: "Senha atual incorreta." });
  if (nova.length < 4) return res.status(400).json({ error: "Nova senha muito curta." });
  db.prepare("UPDATE users SET pass=? WHERE id=?").run(hashPass(nova), req.user.id);
  res.json({ ok: true });
});

app.post("/api/forgot", async (req, res) => {
  const email = normEmail(req.body.email);
  if (!emailOk(email)) return res.status(400).json({ error: "Informe um e-mail valido." });
  const row = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (row) {
    const token = crypto.randomBytes(18).toString("hex");
    db.prepare("INSERT INTO resets (token,user_id,exp) VALUES (?,?,?)").run(token, row.id, Date.now() + 36e5);
    const link = originFrom(req) + "/#reset=" + token;
    const transport = mailer();
    if (transport) {
      try {
        await transport.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: email,
          subject: "Redefinicao de senha - Catalogo Ofertas",
          text: "Use este link para redefinir sua senha:\n\n" + link + "\n\nO link expira em 1 hora."
        });
      } catch (e) {}
    }
  }
  res.json({ ok: true, message: "Se o e-mail estiver cadastrado, o link de renovacao foi enviado." });
});

app.post("/api/reset", (req, res) => {
  const token = String(req.body.token || "");
  const nova = String(req.body.pass || req.body.nova || "");
  const item = db.prepare("SELECT * FROM resets WHERE token=?").get(token);
  if (!item || item.exp < Date.now()) return res.status(400).json({ error: "Link invalido ou expirado." });
  if (nova.length < 4) return res.status(400).json({ error: "Senha muito curta." });
  db.prepare("UPDATE users SET pass=? WHERE id=?").run(hashPass(nova), item.user_id);
  db.prepare("DELETE FROM resets WHERE token=?").run(token);
  res.json({ ok: true });
});

app.get("/api/users", auth, adminOnly, (req, res) => {
  const rows = db.prepare("SELECT id,user,email,role,plan,created_at FROM users ORDER BY id").all();
  res.json({ users: rows });
});

app.post("/api/users", auth, adminOnly, (req, res) => {
  const user = String(req.body.user || "").trim();
  const email = normEmail(req.body.email);
  const pass = String(req.body.pass || "");
  const plan = req.body.plan === "pro" ? "pro" : "free";
  if (!user || !email || !pass) return res.status(400).json({ error: "Informe usuario, e-mail e senha." });
  if (!emailOk(email)) return res.status(400).json({ error: "E-mail invalido." });
  const exists = db.prepare("SELECT id FROM users WHERE lower(user)=? OR email=?").get(user.toLowerCase(), email);
  if (exists) return res.status(409).json({ error: "Usuario ou e-mail ja cadastrado." });
  db.prepare("INSERT INTO users (user,email,pass,role,plan,created_at) VALUES (?,?,?,?,?,?)").run(
    user, email, hashPass(pass), "user", plan, new Date().toISOString()
  );
  res.json({ ok: true });
});

app.delete("/api/users/:id", auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  if (!row) return res.status(404).json({ error: "Usuario nao encontrado." });
  if (row.role === "admin") return res.status(400).json({ error: "Admin nao pode ser removido." });
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
  db.prepare("DELETE FROM catalogs WHERE user_id=?").run(id);
  db.prepare("DELETE FROM resets WHERE user_id=?").run(id);
  db.prepare("DELETE FROM users WHERE id=?").run(id);
  res.json({ ok: true });
});

app.get("/api/catalog", auth, (req, res) => {
  const row = db.prepare("SELECT title,period,layout,products FROM catalogs WHERE user_id=?").get(req.user.id);
  if (!row) return res.json({ title: "OFERTAS", period: "", layout: "", products: [] });
  let products = [];
  try { products = JSON.parse(row.products || "[]"); } catch (e) { products = []; }
  res.json({ title: row.title || "OFERTAS", period: row.period || "", layout: row.layout || "", products });
});

app.put("/api/catalog", auth, (req, res) => {
  const title = String(req.body.title || "OFERTAS");
  const period = String(req.body.period || "");
  const layout = String(req.body.layout || "");
  const products = Array.isArray(req.body.products) ? req.body.products : [];
  const compact = products.map(p => ({
    id: p.id,
    codigo: p.codigo || "000",
    descricao: p.descricao || "",
    embalagem: p.embalagem || "",
    preco: p.preco || "",
    imagem: p.imagem && String(p.imagem).startsWith("http") ? p.imagem : "",
    estado: p.estado || "aguardando",
    observacao: p.observacao || ""
  }));
  db.prepare(`
    INSERT INTO catalogs (user_id,title,period,layout,products,updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET title=excluded.title, period=excluded.period, layout=excluded.layout, products=excluded.products, updated_at=excluded.updated_at
  `).run(req.user.id, title, period, layout, JSON.stringify(compact), new Date().toISOString());
  res.json({ ok: true });
});

app.post("/api/checkout", auth, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
    return res.status(400).json({
      error: "Pagamento ainda nao configurado. Defina STRIPE_SECRET_KEY e STRIPE_PRICE_ID no Render."
    });
  }
  const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  const origin = originFrom(req);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: req.user.email,
    client_reference_id: String(req.user.id),
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: origin + "/?paid=1",
    cancel_url: origin + "/?canceled=1",
    metadata: { userId: String(req.user.id) }
  });
  res.json({ url: session.url });
});

app.post("/api/stripe/webhook", async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeKey || !whsec) return res.status(400).send("webhook nao configurado");
  const stripe = require("stripe")(stripeKey);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], whsec);
  } catch (err) {
    return res.status(400).send("assinatura invalida");
  }
  if (event.type === "checkout.session.completed") {
    const sess = event.data.object;
    const userId = Number(sess.client_reference_id || (sess.metadata && sess.metadata.userId) || 0);
    if (userId) {
      db.prepare("UPDATE users SET plan='pro', stripe_customer=?, stripe_subscription=? WHERE id=?").run(
        sess.customer || null,
        sess.subscription || null,
        userId
      );
    }
  }
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    db.prepare("UPDATE users SET plan='free' WHERE stripe_subscription=?").run(sub.id);
  }
  res.json({ received: true });
});

app.use(express.static(__dirname, { extensions: ["html"] }));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

initDb().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("Listening on port " + PORT);
  });
}).catch(err => {
  console.error(err);
  process.exit(1);
});
