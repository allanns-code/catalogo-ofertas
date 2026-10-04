const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");

const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@catalogo.local").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const APP_URL = process.env.APP_URL || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATABASE_URL = process.env.DATABASE_URL || "";
const isPg = Boolean(DATABASE_URL);
fs.mkdirSync(DATA_DIR, { recursive: true });
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "app.db");
let db;

function wrapSqlJs(raw) {
  function persist() {
    fs.writeFileSync(DB_FILE, Buffer.from(raw.export()));
  }
  return {
    async exec(sql) {
      raw.exec(sql);
      persist();
    },
    prepare(sql) {
      return {
        async get(...params) {
          const stmt = raw.prepare(sql);
          if (params.length) stmt.bind(params);
          const row = stmt.step() ? stmt.getAsObject() : undefined;
          stmt.free();
          return row;
        },
        async all(...params) {
          const stmt = raw.prepare(sql);
          if (params.length) stmt.bind(params);
          const rows = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          stmt.free();
          return rows;
        },
        async run(...params) {
          raw.run(sql, params);
          const r = raw.exec("SELECT last_insert_rowid() AS id");
          const lastInsertRowid = r.length && r[0].values.length ? r[0].values[0][0] : 0;
          persist();
          return { lastInsertRowid };
        }
      };
    }
  };
}

function wrapPg(pool) {
  function toPg(sql) {
    let n = 0;
    return sql.replace(/\?/g, () => "$" + (++n));
  }
  return {
    async exec(sql) {
      await pool.query(sql);
    },
    prepare(sql) {
      return {
        async get(...params) {
          const r = await pool.query(toPg(sql), params);
          return r.rows[0];
        },
        async all(...params) {
          const r = await pool.query(toPg(sql), params);
          return r.rows;
        },
        async run(...params) {
          let q = toPg(sql);
          if (/^\s*insert/i.test(sql) && !/returning/i.test(sql) && /into\s+(users|catalog_docs)\b/i.test(sql)) q += " RETURNING id";
          const r = await pool.query(q, params);
          return { lastInsertRowid: r.rows[0] && r.rows[0].id };
        }
      };
    }
  };
}

const idCol = isPg ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id ${idCol},
  "user" TEXT NOT NULL UNIQUE,
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
  exp ${isPg ? "BIGINT" : "INTEGER"} NOT NULL
);
CREATE TABLE IF NOT EXISTS resets (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  exp ${isPg ? "BIGINT" : "INTEGER"} NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_docs (
  id ${idCol},
  user_id INTEGER NOT NULL,
  name TEXT,
  title TEXT,
  period TEXT,
  layout TEXT,
  products TEXT,
  updated_at TEXT
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
function mailReady() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}
function compactProducts(products) {
  return (Array.isArray(products) ? products : []).map(p => {
    const img = String(p.imagem || "");
    const keep = img.startsWith("http") || img.startsWith("/uploads/");
    return {
      id: p.id,
      codigo: p.codigo || "000",
      descricao: p.descricao || "",
      embalagem: p.embalagem || "",
      preco: p.preco || "",
      imagem: keep ? img : "",
      estado: p.estado || "aguardando",
      observacao: p.observacao || ""
    };
  });
}
function parseProducts(raw) {
  try { return JSON.parse(raw || "[]"); } catch (e) { return []; }
}
function docPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || row.title || "Catalogo",
    title: row.title || "OFERTAS",
    period: row.period || "",
    layout: row.layout || "",
    products: parseProducts(row.products),
    updated_at: row.updated_at || ""
  };
}

async function seedAdmin() {
  const existingAdmin = await db.prepare('SELECT id FROM users WHERE "user" = ? OR email = ?').get(ADMIN_USER, ADMIN_EMAIL);
  if (!existingAdmin) {
    await db.prepare('INSERT INTO users ("user",email,pass,role,plan,created_at) VALUES (?,?,?,?,?,?)').run(
      ADMIN_USER,
      ADMIN_EMAIL,
      hashPass(ADMIN_PASSWORD),
      "admin",
      "pro",
      new Date().toISOString()
    );
  } else {
    await db.prepare("UPDATE users SET role='admin', plan='pro', pass=? WHERE id=?").run(hashPass(ADMIN_PASSWORD), existingAdmin.id);
  }
}

async function migrateOldCatalogs() {
  try {
    const old = await db.prepare("SELECT user_id,title,period,layout,products,updated_at FROM catalogs").all();
    for (const row of old) {
      const exists = await db.prepare("SELECT id FROM catalog_docs WHERE user_id=?").get(row.user_id);
      if (!exists) {
        await db.prepare("INSERT INTO catalog_docs (user_id,name,title,period,layout,products,updated_at) VALUES (?,?,?,?,?,?,?)").run(
          row.user_id,
          row.title || "Meu catalogo",
          row.title || "OFERTAS",
          row.period || "",
          row.layout || "",
          row.products || "[]",
          row.updated_at || new Date().toISOString()
        );
      }
    }
  } catch (e) {}
}

async function initDb() {
  if (isPg) {
    const { Pool } = require("pg");
    const pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSL === "0" ? false : { rejectUnauthorized: false }
    });
    db = wrapPg(pool);
  } else {
    const initSqlJs = require("sql.js");
    const SQL = await initSqlJs();
    const raw = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
    db = wrapSqlJs(raw);
  }
  await db.exec(SCHEMA);
  await migrateOldCatalogs();
  await seedAdmin();
}

function mailer() {
  if (!mailReady()) return null;
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
app.use(express.json({ limit: "12mb" }));
app.use(cookieParser(SESSION_SECRET));
app.use("/uploads", express.static(UPLOAD_DIR));

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
async function getUser(req) {
  const token = req.cookies.sid;
  if (!token) return null;
  const sess = await db.prepare("SELECT user_id, exp FROM sessions WHERE token=?").get(token);
  if (!sess || Number(sess.exp) < Date.now()) {
    if (sess) await db.prepare("DELETE FROM sessions WHERE token=?").run(token);
    return null;
  }
  return await db.prepare("SELECT * FROM users WHERE id=?").get(sess.user_id);
}
async function auth(req, res, next) {
  try {
    req.user = await getUser(req);
    if (!req.user) return res.status(401).json({ error: "Nao autenticado" });
    next();
  } catch (e) {
    res.status(500).json({ error: "Erro de sessao" });
  }
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "Acesso admin" });
  next();
}
async function ownedDoc(req, res) {
  const id = Number(req.params.id);
  const row = await db.prepare("SELECT * FROM catalog_docs WHERE id=? AND user_id=?").get(id, req.user.id);
  if (!row) {
    res.status(404).json({ error: "Catalogo nao encontrado." });
    return null;
  }
  return row;
}

app.get("/api/status", (req, res) => {
  res.json({ mailReady: mailReady() });
});

app.post("/api/register", async (req, res) => {
  try {
    const user = String(req.body.user || "").trim();
    const email = normEmail(req.body.email);
    const pass = String(req.body.pass || req.body.password || "");
    if (!user || !email || !pass) return res.status(400).json({ error: "Informe usuario, e-mail e senha." });
    if (/\s/.test(user)) return res.status(400).json({ error: "Usuario sem espacos." });
    if (!emailOk(email)) return res.status(400).json({ error: "E-mail invalido." });
    if (pass.length < 4) return res.status(400).json({ error: "Senha muito curta." });
    const exists = await db.prepare('SELECT id FROM users WHERE lower("user")=? OR email=?').get(user.toLowerCase(), email);
    if (exists) return res.status(409).json({ error: "Usuario ou e-mail ja cadastrado." });
    const info = await db.prepare('INSERT INTO users ("user",email,pass,role,plan,created_at) VALUES (?,?,?,?,?,?)').run(
      user, email, hashPass(pass), "user", "free", new Date().toISOString()
    );
    const token = crypto.randomBytes(24).toString("hex");
    await db.prepare("INSERT INTO sessions (token,user_id,exp) VALUES (?,?,?)").run(token, info.lastInsertRowid, Date.now() + 30 * 864e5);
    setSession(res, token);
    const row = await db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
    res.json({ user: publicUser(row) });
  } catch (e) {
    res.status(500).json({ error: "Falha ao cadastrar." });
  }
});

app.post("/api/login", async (req, res) => {
  const login = String(req.body.login || req.body.user || "").trim().toLowerCase();
  const pass = String(req.body.pass || req.body.password || "");
  const row = await db.prepare('SELECT * FROM users WHERE lower("user")=? OR email=?').get(login, login);
  if (!row || !checkPass(pass, row.pass)) return res.status(401).json({ error: "Usuario, e-mail ou senha invalidos." });
  const token = crypto.randomBytes(24).toString("hex");
  await db.prepare("INSERT INTO sessions (token,user_id,exp) VALUES (?,?,?)").run(token, row.id, Date.now() + 30 * 864e5);
  setSession(res, token);
  res.json({ user: publicUser(row) });
});

app.post("/api/logout", auth, async (req, res) => {
  const token = req.cookies.sid;
  if (token) await db.prepare("DELETE FROM sessions WHERE token=?").run(token);
  clearSession(res);
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => {
  res.json({
    user: publicUser(req.user),
    billingReady: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID),
    mailReady: mailReady()
  });
});

app.post("/api/password", auth, async (req, res) => {
  const atual = String(req.body.atual || "");
  const nova = String(req.body.nova || "");
  if (!checkPass(atual, req.user.pass)) return res.status(400).json({ error: "Senha atual incorreta." });
  if (nova.length < 4) return res.status(400).json({ error: "Nova senha muito curta." });
  await db.prepare("UPDATE users SET pass=? WHERE id=?").run(hashPass(nova), req.user.id);
  res.json({ ok: true });
});

app.post("/api/forgot", async (req, res) => {
  const email = normEmail(req.body.email);
  if (!emailOk(email)) return res.status(400).json({ error: "Informe um e-mail valido." });
  if (!mailReady()) {
    return res.json({
      ok: true,
      mailReady: false,
      message: "O envio de e-mail ainda nao foi configurado. Peca ao administrador para redefinir sua senha."
    });
  }
  const row = await db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (row) {
    const token = crypto.randomBytes(18).toString("hex");
    await db.prepare("INSERT INTO resets (token,user_id,exp) VALUES (?,?,?)").run(token, row.id, Date.now() + 36e5);
    const link = originFrom(req) + "/#reset=" + token;
    const transport = mailer();
    try {
      await transport.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: email,
        subject: "Redefinicao de senha - Catalogo Ofertas",
        text: "Use este link para redefinir sua senha:\n\n" + link + "\n\nO link expira em 1 hora."
      });
    } catch (e) {}
  }
  res.json({ ok: true, mailReady: true, message: "Se o e-mail estiver cadastrado, o link de renovacao foi enviado." });
});

app.post("/api/reset", async (req, res) => {
  const token = String(req.body.token || "");
  const nova = String(req.body.pass || req.body.nova || "");
  const item = await db.prepare("SELECT * FROM resets WHERE token=?").get(token);
  if (!item || Number(item.exp) < Date.now()) return res.status(400).json({ error: "Link invalido ou expirado." });
  if (nova.length < 4) return res.status(400).json({ error: "Senha muito curta." });
  await db.prepare("UPDATE users SET pass=? WHERE id=?").run(hashPass(nova), item.user_id);
  await db.prepare("DELETE FROM resets WHERE token=?").run(token);
  res.json({ ok: true });
});

app.get("/api/users", auth, adminOnly, async (req, res) => {
  const rows = await db.prepare('SELECT id,"user",email,role,plan,created_at FROM users ORDER BY id').all();
  res.json({ users: rows });
});

app.post("/api/users", auth, adminOnly, async (req, res) => {
  const user = String(req.body.user || "").trim();
  const email = normEmail(req.body.email);
  const pass = String(req.body.pass || "");
  const plan = req.body.plan === "pro" ? "pro" : "free";
  if (!user || !email || !pass) return res.status(400).json({ error: "Informe usuario, e-mail e senha." });
  if (!emailOk(email)) return res.status(400).json({ error: "E-mail invalido." });
  const exists = await db.prepare('SELECT id FROM users WHERE lower("user")=? OR email=?').get(user.toLowerCase(), email);
  if (exists) return res.status(409).json({ error: "Usuario ou e-mail ja cadastrado." });
  await db.prepare('INSERT INTO users ("user",email,pass,role,plan,created_at) VALUES (?,?,?,?,?,?)').run(
    user, email, hashPass(pass), "user", plan, new Date().toISOString()
  );
  res.json({ ok: true });
});

app.post("/api/users/:id/password", auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const nova = String(req.body.nova || req.body.pass || "");
  if (nova.length < 4) return res.status(400).json({ error: "Nova senha muito curta." });
  const row = await db.prepare("SELECT * FROM users WHERE id=?").get(id);
  if (!row) return res.status(404).json({ error: "Usuario nao encontrado." });
  await db.prepare("UPDATE users SET pass=? WHERE id=?").run(hashPass(nova), id);
  await db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
  res.json({ ok: true });
});

app.delete("/api/users/:id", auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const row = await db.prepare("SELECT * FROM users WHERE id=?").get(id);
  if (!row) return res.status(404).json({ error: "Usuario nao encontrado." });
  if (row.role === "admin") return res.status(400).json({ error: "Admin nao pode ser removido." });
  await db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
  await db.prepare("DELETE FROM catalog_docs WHERE user_id=?").run(id);
  await db.prepare("DELETE FROM resets WHERE user_id=?").run(id);
  await db.prepare("DELETE FROM users WHERE id=?").run(id);
  res.json({ ok: true });
});

app.get("/api/catalogs", auth, async (req, res) => {
  const rows = await db.prepare("SELECT id,name,title,period,layout,updated_at FROM catalog_docs WHERE user_id=? ORDER BY id").all(req.user.id);
  res.json({ catalogs: rows.map(r => ({ id: r.id, name: r.name || r.title || "Catalogo", title: r.title, period: r.period, layout: r.layout, updated_at: r.updated_at })) });
});

app.post("/api/catalogs", auth, async (req, res) => {
  const name = String(req.body.name || "Novo catalogo").trim() || "Novo catalogo";
  const title = String(req.body.title || "OFERTAS");
  const period = String(req.body.period || "");
  const layout = String(req.body.layout || "");
  const products = JSON.stringify(compactProducts(req.body.products || []));
  const info = await db.prepare("INSERT INTO catalog_docs (user_id,name,title,period,layout,products,updated_at) VALUES (?,?,?,?,?,?,?)").run(
    req.user.id, name, title, period, layout, products, new Date().toISOString()
  );
  const row = await db.prepare("SELECT * FROM catalog_docs WHERE id=?").get(info.lastInsertRowid);
  res.json(docPublic(row));
});

app.post("/api/catalogs/:id/duplicate", auth, async (req, res) => {
  const src = await ownedDoc(req, res);
  if (!src) return;
  const info = await db.prepare("INSERT INTO catalog_docs (user_id,name,title,period,layout,products,updated_at) VALUES (?,?,?,?,?,?,?)").run(
    req.user.id,
    (src.name || src.title || "Catalogo") + " (copia)",
    src.title,
    src.period,
    src.layout,
    src.products,
    new Date().toISOString()
  );
  const row = await db.prepare("SELECT * FROM catalog_docs WHERE id=?").get(info.lastInsertRowid);
  res.json(docPublic(row));
});

app.get("/api/catalogs/:id", auth, async (req, res) => {
  const row = await ownedDoc(req, res);
  if (!row) return;
  res.json(docPublic(row));
});

app.put("/api/catalogs/:id", auth, async (req, res) => {
  const row = await ownedDoc(req, res);
  if (!row) return;
  const name = String(req.body.name || row.name || row.title || "Catalogo");
  const title = String(req.body.title || "OFERTAS");
  const period = String(req.body.period || "");
  const layout = String(req.body.layout || "");
  const products = JSON.stringify(compactProducts(req.body.products));
  await db.prepare("UPDATE catalog_docs SET name=?, title=?, period=?, layout=?, products=?, updated_at=? WHERE id=?").run(
    name, title, period, layout, products, new Date().toISOString(), row.id
  );
  res.json({ ok: true });
});

app.delete("/api/catalogs/:id", auth, async (req, res) => {
  const row = await ownedDoc(req, res);
  if (!row) return;
  const count = await db.prepare("SELECT COUNT(*) AS n FROM catalog_docs WHERE user_id=?").get(req.user.id);
  if (Number(count && count.n) <= 1) return res.status(400).json({ error: "Mantenha pelo menos um catalogo." });
  await db.prepare("DELETE FROM catalog_docs WHERE id=?").run(row.id);
  res.json({ ok: true });
});

app.get("/api/catalog", auth, async (req, res) => {
  let row = await db.prepare("SELECT * FROM catalog_docs WHERE user_id=? ORDER BY id LIMIT 1").get(req.user.id);
  if (!row) {
    const info = await db.prepare("INSERT INTO catalog_docs (user_id,name,title,period,layout,products,updated_at) VALUES (?,?,?,?,?,?,?)").run(
      req.user.id, "Meu catalogo", "OFERTAS", "", "", "[]", new Date().toISOString()
    );
    row = await db.prepare("SELECT * FROM catalog_docs WHERE id=?").get(info.lastInsertRowid);
  }
  res.json(docPublic(row));
});

app.put("/api/catalog", auth, async (req, res) => {
  let row = await db.prepare("SELECT * FROM catalog_docs WHERE user_id=? ORDER BY id LIMIT 1").get(req.user.id);
  const name = String(req.body.name || (row && row.name) || req.body.title || "Meu catalogo");
  const title = String(req.body.title || "OFERTAS");
  const period = String(req.body.period || "");
  const layout = String(req.body.layout || "");
  const products = JSON.stringify(compactProducts(req.body.products));
  if (!row) {
    await db.prepare("INSERT INTO catalog_docs (user_id,name,title,period,layout,products,updated_at) VALUES (?,?,?,?,?,?,?)").run(
      req.user.id, name, title, period, layout, products, new Date().toISOString()
    );
  } else {
    await db.prepare("UPDATE catalog_docs SET name=?, title=?, period=?, layout=?, products=?, updated_at=? WHERE id=?").run(
      name, title, period, layout, products, new Date().toISOString(), row.id
    );
  }
  res.json({ ok: true });
});

app.post("/api/upload", auth, (req, res) => {
  try {
    const dataUrl = String(req.body.image || req.body.dataUrl || "");
    const m = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i);
    if (!m) return res.status(400).json({ error: "Imagem invalida." });
    const ext = m[1].toLowerCase().includes("png") ? "png" : m[1].toLowerCase().includes("webp") ? "webp" : "jpg";
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 6 * 1024 * 1024) return res.status(400).json({ error: "Imagem muito grande." });
    const name = Date.now() + "-" + crypto.randomBytes(6).toString("hex") + "." + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    res.json({ url: "/uploads/" + name });
  } catch (e) {
    res.status(400).json({ error: "Falha ao salvar imagem." });
  }
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
      await db.prepare("UPDATE users SET plan='pro', stripe_customer=?, stripe_subscription=? WHERE id=?").run(
        sess.customer || null,
        sess.subscription || null,
        userId
      );
    }
  }
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    await db.prepare("UPDATE users SET plan='free' WHERE stripe_subscription=?").run(sub.id);
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
