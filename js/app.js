const $ = s => document.querySelector(s);
function on(sel, ev, fn) {
  const el = typeof sel === "string" ? $(sel) : sel;
  if (!el) return;
  el.addEventListener(ev, fn);
}
const gr = $("#gr");
const st = $("#st");
const bus = $("#bus");
const finalBtn = $("#final");
const addBtn = $("#add");
const inp = $("#inp");
const upz = $("#upz");
const arq = $("#arq");

const MIN_PASSWORD = 8;
const FREE_MAX_PRODUCTS = 12;
const CARDS_PER_PAGE = 9;

let currentUser = null;
let billingReady = false;
let mailReady = false;
let saveTimer = 0;
let currentDocId = 0;
let docsCache = [];
let planLimits = { plan: "free", maxCatalogs: 1, maxProducts: FREE_MAX_PRODUCTS };
let prods = [];
let editando = true;
let idCounter = 0;
let layoutAtual = "";
let imgTargetId = 0;
let resetUserId = 0;
let resetUserName = "";

function emailOk(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
}
function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}
function isAdmin(u) {
  return !!u && u.role === "admin";
}
function isPro(u) {
  return !!u && (u.plan === "pro" || u.role === "admin");
}
function getSess() {
  return currentUser;
}
function setStatus(msg, kind) {
  st.textContent = msg;
  st.classList.remove("err", "ok");
  if (kind) st.classList.add(kind);
}
async function api(path, opts) {
  const r = await fetch(path, Object.assign({ credentials: "same-origin", headers: { "Content-Type": "application/json" } }, opts || {}));
  let data = {};
  try { data = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(data.error || ("Erro " + r.status));
  return data;
}
function applyLimits(data) {
  if (data && data.limits) planLimits = data.limits;
  else if (currentUser) {
    planLimits = isPro(currentUser)
      ? { plan: "pro", maxCatalogs: 0, maxProducts: 0 }
      : { plan: "free", maxCatalogs: 1, maxProducts: FREE_MAX_PRODUCTS };
  }
}
function maxProducts() {
  return planLimits.maxProducts || 0;
}
function maxCatalogs() {
  return planLimits.maxCatalogs || 0;
}

async function renderUsers() {
  try {
    const data = await api("/api/users");
    $("#ulist").innerHTML = (data.users || []).map(u => {
      const reset = '<button class="bt a" type="button" data-reset-id="' + u.id + '" data-reset-name="' + es(u.user) + '">Senha</button>';
      const del = u.role === "admin" ? "" : ' <button class="del" type="button" data-del-id="' + u.id + '">Excluir</button>';
      const plan = u.role === "admin" ? "Pro" : (
        '<select class="cp" data-plan-id="' + u.id + '">' +
        '<option value="free"' + (u.plan !== "pro" ? " selected" : "") + ">Gratuito</option>" +
        '<option value="pro"' + (u.plan === "pro" ? " selected" : "") + ">Pro</option>" +
        "</select>"
      );
      const perfil = u.role === "admin" ? "Admin" : "Usuário";
      return "<tr><td>" + es(u.user) + "</td><td>" + es(u.email || "-") + "</td><td>" + perfil + "</td><td>" + plan + "</td><td class=\"acts\">" + reset + del + "</td></tr>";
    }).join("");
  } catch (e) {
    $("#admSt").textContent = e.message;
  }
}

const LAYOUTS = {
  semana: { cls: "lay-semana", titulo: "OFERTAS DA SEMANA" },
  food: { cls: "lay-food", titulo: "OFERTAS FOOD SERVICE" },
  pani: { cls: "lay-pani", titulo: "#SEXTA DA PANIFICACAO" }
};

function aplicarLayout(id, forcarTitulo, semSalvar) {
  const lay = LAYOUTS[id];
  if (!lay) return;
  layoutAtual = id;
  const catEl = $("#cat");
  catEl.classList.remove("lay-semana", "lay-food", "lay-pani");
  catEl.classList.add(lay.cls);
  document.querySelectorAll(".lay-card").forEach(c => c.classList.toggle("on", c.dataset.lay === id));
  if (forcarTitulo || !$("#tit").value || $("#tit").value === "OFERTAS") {
    $("#tit").value = lay.titulo;
    $("#titS").textContent = lay.titulo;
  }
  rdr();
  if (!semSalvar) agendarSalvar();
}
function abrirLayoutModal() {
  $("#layModal").classList.add("on");
}
function fecharLayoutModal() {
  $("#layModal").classList.remove("on");
}
function esconderPaineis() {
  $("#app").style.display = "none";
  $("#adminPnl").style.display = "none";
  $("#contaPnl").style.display = "none";
  $("#tabCat").classList.remove("on");
  $("#tabAdm").classList.remove("on");
  $("#tabConta").classList.remove("on");
}
function atualizarConta() {
  const u = currentUser;
  if (!u) return;
  const pro = isPro(u);
  $("#planInfo").textContent = pro
    ? "Plano atual: Pro. Catálogos e produtos ilimitados."
    : "Plano atual: gratuito. 1 catálogo e até " + FREE_MAX_PRODUCTS + " produtos.";
  $("#payBtn").hidden = pro || !billingReady;
}
function mostrarApp(user) {
  currentUser = user;
  $("#login").style.display = "none";
  $("#topbar").style.display = "flex";
  esconderPaineis();
  $("#app").style.display = "block";
  $("#tabCat").classList.add("on");
  $("#who").textContent = user.user + (isPro(user) ? " · Pro" : "");
  $("#tabAdm").hidden = !isAdmin(user);
  atualizarConta();
}
function mostrarLoginBox() {
  $("#loginForm").hidden = false;
  $("#regForm").hidden = true;
  $("#forgotForm").hidden = true;
  $("#resetForm").hidden = true;
  $("#le").textContent = "";
  $("#rerr").textContent = "";
}
function mostrarLogin() {
  currentUser = null;
  $("#login").style.display = "flex";
  $("#topbar").style.display = "none";
  esconderPaineis();
  mostrarLoginBox();
  $("#lp").value = "";
}

on("#loginForm", "submit", async e => {
  e.preventDefault();
  $("#le").textContent = "";
  try {
    const data = await api("/api/login", { method: "POST", body: JSON.stringify({ login: $("#lu").value.trim(), pass: $("#lp").value }) });
    applyLimits(data);
    await entrar(data.user);
  } catch (err) {
    $("#le").textContent = err.message;
  }
});
on("#goReg", "click", () => {
  $("#loginForm").hidden = true;
  $("#forgotForm").hidden = true;
  $("#resetForm").hidden = true;
  $("#regForm").hidden = false;
  $("#rerr").textContent = "";
});
on("#backLogin3", "click", mostrarLoginBox);
on("#regForm", "submit", async e => {
  e.preventDefault();
  $("#rerr").textContent = "";
  if ($("#rp").value.length < MIN_PASSWORD) {
    $("#rerr").textContent = "A senha precisa ter no mínimo " + MIN_PASSWORD + " caracteres.";
    return;
  }
  try {
    const data = await api("/api/register", { method: "POST", body: JSON.stringify({ user: $("#ru").value.trim(), email: $("#re").value, pass: $("#rp").value }) });
    applyLimits(data);
    await entrar(data.user);
  } catch (err) {
    $("#rerr").textContent = err.message;
  }
});
on("#sair", "click", async () => {
  try { await api("/api/logout", { method: "POST", body: "{}" }); } catch (e) {}
  mostrarLogin();
});
on("#tabCat", "click", () => {
  esconderPaineis();
  $("#app").style.display = "block";
  $("#tabCat").classList.add("on");
});
on("#tabAdm", "click", () => {
  const sess = getSess();
  if (!isAdmin(sess)) return;
  esconderPaineis();
  $("#adminPnl").style.display = "block";
  $("#tabAdm").classList.add("on");
  renderUsers();
});
on("#tabLay", "click", abrirLayoutModal);
on("#btnLay", "click", abrirLayoutModal);
document.querySelectorAll(".lay-card").forEach(card => {
  card.addEventListener("click", () => {
    aplicarLayout(card.dataset.lay, true);
    fecharLayoutModal();
  });
});
on("#tabConta", "click", () => {
  esconderPaineis();
  $("#contaPnl").style.display = "block";
  $("#tabConta").classList.add("on");
  $("#contaSt").textContent = "";
  $("#senAtu").value = "";
  $("#senNova").value = "";
  $("#senConf").value = "";
  atualizarConta();
});
on("#addUser", "click", async () => {
  const sess = getSess();
  if (!isAdmin(sess)) return;
  const user = $("#nu").value.trim();
  const email = normEmail($("#ne").value);
  const pass = $("#np").value;
  if (!user || !email || !pass) { $("#admSt").textContent = "Informe usuário, e-mail e senha."; return; }
  if (/\s/.test(user)) { $("#admSt").textContent = "Usuário sem espaços."; return; }
  if (!emailOk(email)) { $("#admSt").textContent = "E-mail inválido."; return; }
  if (pass.length < MIN_PASSWORD) { $("#admSt").textContent = "A senha precisa ter no mínimo " + MIN_PASSWORD + " caracteres."; return; }
  try {
    const plan = $("#nplan").value === "pro" ? "pro" : "free";
    await api("/api/users", { method: "POST", body: JSON.stringify({ user, email, pass, plan }) });
    $("#nu").value = "";
    $("#ne").value = "";
    $("#np").value = "";
    $("#nplan").value = "free";
    $("#admSt").textContent = "Usuário " + user + " adicionado no plano " + (plan === "pro" ? "Pro" : "gratuito") + ".";
    renderUsers();
  } catch (err) {
    $("#admSt").textContent = err.message;
  }
});
on("#ulist", "click", e => {
  const del = e.target.closest("[data-del-id]");
  if (del) {
    excluirUser(Number(del.dataset.delId));
    return;
  }
  const reset = e.target.closest("[data-reset-id]");
  if (reset) abrirPassModal(Number(reset.dataset.resetId), reset.dataset.resetName);
});
on("#ulist", "change", async e => {
  const sel = e.target.closest("[data-plan-id]");
  if (!sel) return;
  const id = Number(sel.dataset.planId);
  const plan = sel.value === "pro" ? "pro" : "free";
  try {
    await api("/api/users/" + id + "/plan", { method: "POST", body: JSON.stringify({ plan }) });
    $("#admSt").textContent = "Plano atualizado para " + (plan === "pro" ? "Pro" : "gratuito") + ".";
  } catch (err) {
    $("#admSt").textContent = err.message;
    renderUsers();
  }
});
async function excluirUser(id) {
  try {
    await api("/api/users/" + id, { method: "DELETE" });
    $("#admSt").textContent = "Usuário removido.";
    renderUsers();
  } catch (e) {
    $("#admSt").textContent = e.message;
  }
}
function abrirPassModal(id, nome) {
  resetUserId = id;
  resetUserName = nome || "";
  $("#passHint").textContent = "Nova senha para " + resetUserName + " (mínimo " + MIN_PASSWORD + " caracteres).";
  $("#passNova").value = "";
  $("#passConf").value = "";
  $("#passErr").textContent = "";
  $("#passModal").classList.add("on");
}
on("#passCancel", "click", () => $("#passModal").classList.remove("on"));
on("#passSave", "click", async () => {
  const nova = $("#passNova").value;
  const conf = $("#passConf").value;
  if (nova.length < MIN_PASSWORD) { $("#passErr").textContent = "A senha precisa ter no mínimo " + MIN_PASSWORD + " caracteres."; return; }
  if (nova !== conf) { $("#passErr").textContent = "Confirmação não confere."; return; }
  try {
    await api("/api/users/" + resetUserId + "/password", { method: "POST", body: JSON.stringify({ nova }) });
    $("#admSt").textContent = "Senha de " + resetUserName + " redefinida.";
    $("#passModal").classList.remove("on");
  } catch (e) {
    $("#passErr").textContent = e.message;
  }
});
on("#savePass", "click", async () => {
  if (!getSess()) return;
  const atual = $("#senAtu").value;
  const nova = $("#senNova").value;
  const conf = $("#senConf").value;
  if (nova.length < MIN_PASSWORD) { $("#contaSt").textContent = "A senha precisa ter no mínimo " + MIN_PASSWORD + " caracteres."; return; }
  if (nova !== conf) { $("#contaSt").textContent = "Confirmação não confere."; return; }
  try {
    await api("/api/password", { method: "POST", body: JSON.stringify({ atual, nova }) });
    $("#senAtu").value = "";
    $("#senNova").value = "";
    $("#senConf").value = "";
    $("#contaSt").textContent = "Senha alterada.";
  } catch (err) {
    $("#contaSt").textContent = err.message;
  }
});
on("#payBtn", "click", async () => {
  $("#contaSt").textContent = "Abrindo checkout...";
  try {
    const data = await api("/api/checkout", { method: "POST", body: "{}" });
    if (data.url) location.href = data.url;
  } catch (err) {
    $("#contaSt").textContent = err.message;
  }
});
async function showForgot() {
  $("#loginForm").hidden = true;
  $("#regForm").hidden = true;
  $("#resetForm").hidden = true;
  $("#forgotForm").hidden = false;
  $("#fer").textContent = "";
  $("#fok").textContent = "";
  $("#fe").value = "";
  try {
    const s = await api("/api/status");
    mailReady = !!s.mailReady;
  } catch (e) {}
  $("#forgotHint").textContent = mailReady
    ? "Informe o e-mail cadastrado. Enviaremos um link para renovar a senha."
    : "O envio de e-mail ainda não foi configurado. Peça ao administrador para redefinir sua senha. No Render, defina SMTP_HOST, SMTP_USER, SMTP_PASS e SMTP_FROM.";
}
on("#goReset", "click", showForgot);
on("#backLogin1", "click", mostrarLoginBox);
on("#backLogin2", "click", mostrarLoginBox);
on("#forgotForm", "submit", async e => {
  e.preventDefault();
  const email = normEmail($("#fe").value);
  $("#fer").textContent = "";
  $("#fok").textContent = "";
  if (!emailOk(email)) { $("#fer").textContent = "Informe um e-mail válido."; return; }
  try {
    const data = await api("/api/forgot", { method: "POST", body: JSON.stringify({ email }) });
    $("#fok").textContent = data.message || "Se o e-mail estiver cadastrado, o link de renovação foi enviado.";
  } catch (err) {
    $("#fer").textContent = err.message;
  }
});
on("#resetForm", "submit", async e => {
  e.preventDefault();
  const token = (location.hash.match(/reset=([a-f0-9]+)/i) || [])[1];
  const n1 = $("#np1").value, n2 = $("#np2").value;
  if (n1.length < MIN_PASSWORD) { $("#rer").textContent = "A senha precisa ter no mínimo " + MIN_PASSWORD + " caracteres."; return; }
  if (n1 !== n2) { $("#rer").textContent = "Confirmação não confere."; return; }
  try {
    await api("/api/reset", { method: "POST", body: JSON.stringify({ token, pass: n1 }) });
    history.replaceState(null, "", location.pathname + location.search);
    mostrarLoginBox();
    $("#le").textContent = "Senha redefinida. Entre novamente.";
  } catch (err) {
    $("#rer").textContent = err.message;
  }
});

function snapshotCatalogo() {
  const sel = $("#docSel");
  const name = sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : ($("#tit").value.trim() || "Catalogo");
  return {
    name,
    title: $("#tit").value.trim() || "OFERTAS",
    period: $("#per").value.trim(),
    layout: layoutAtual || "",
    products: prods.map(p => ({
      id: p.id, codigo: p.codigo, descricao: p.descricao, embalagem: p.embalagem || "",
      preco: p.preco, imagem: p.imagem && (String(p.imagem).startsWith("http") || String(p.imagem).startsWith("/uploads/")) ? p.imagem : "",
      estado: p.estado || "aguardando", observacao: p.observacao || ""
    }))
  };
}
function renderDocs() {
  const sel = $("#docSel");
  sel.innerHTML = docsCache.map(d => '<option value="' + d.id + '">' + es(d.name || d.title || "Catalogo") + "</option>").join("");
  if (currentDocId) sel.value = String(currentDocId);
}
async function listarDocs() {
  const data = await api("/api/catalogs");
  applyLimits(data);
  docsCache = data.catalogs || [];
  if (!docsCache.length) {
    const created = await api("/api/catalogs", { method: "POST", body: JSON.stringify({ name: "Meu catalogo", title: "OFERTAS" }) });
    docsCache = [{ id: created.id, name: created.name, title: created.title }];
    currentDocId = created.id;
  }
  if (!currentDocId || !docsCache.some(d => Number(d.id) === Number(currentDocId))) currentDocId = Number(docsCache[0].id);
  renderDocs();
}
function aplicarDoc(data) {
  currentDocId = data.id;
  $("#tit").value = data.title || "OFERTAS";
  $("#per").value = data.period || "";
  $("#titS").textContent = $("#tit").value;
  $("#perS").textContent = $("#per").value;
  prods = Array.isArray(data.products) ? data.products : [];
  idCounter = prods.reduce((m, p) => Math.max(m, Number(p.id) || 0), 0);
  bus.disabled = prods.length ? 0 : 1;
  finalBtn.disabled = prods.length ? 0 : 1;
  layoutAtual = "";
  const catEl = $("#cat");
  catEl.classList.remove("lay-semana", "lay-food", "lay-pani");
  if (data.layout && LAYOUTS[data.layout]) aplicarLayout(data.layout, false, true);
  else rdr();
}
async function salvarAgora() {
  if (!currentUser || !currentDocId) return;
  try {
    await api("/api/catalogs/" + currentDocId, { method: "PUT", body: JSON.stringify(snapshotCatalogo()) });
  } catch (e) {
    setStatus("Não foi possível salvar: " + e.message, "err");
  }
}
function agendarSalvar() {
  if (!currentUser || !currentDocId) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(salvarAgora, 600);
}
async function carregarCatalogo(id) {
  if (id) currentDocId = id;
  if (!currentDocId) await listarDocs();
  const data = await api("/api/catalogs/" + currentDocId);
  aplicarDoc(data);
  renderDocs();
}
async function entrar(user) {
  if (!user || !user.user) throw new Error("Conta criada, mas a sessão não abriu. Tente entrar.");
  mostrarApp(user);
  try {
    await listarDocs();
    await carregarCatalogo(currentDocId);
  } catch (e) {
    setStatus(e.message, "err");
  }
  if (!layoutAtual) abrirLayoutModal();
}
async function boot() {
  const token = (location.hash.match(/reset=([a-f0-9]+)/i) || [])[1];
  if (token) {
    mostrarLogin();
    $("#loginForm").hidden = true;
    $("#regForm").hidden = true;
    $("#forgotForm").hidden = true;
    $("#resetForm").hidden = false;
    $("#rer").textContent = "";
    return;
  }
  try {
    const data = await api("/api/me");
    billingReady = !!data.billingReady;
    mailReady = !!data.mailReady;
    applyLimits(data);
    await entrar(data.user);
    const q = new URLSearchParams(location.search);
    if (q.get("paid") === "1") $("#contaSt").textContent = "Pagamento confirmado. Atualize se o plano ainda não mudou.";
  } catch (e) {
    mostrarLogin();
  }
}

function criarInputImagem() {
  const el = document.createElement("input");
  el.type = "file";
  el.accept = "image/*";
  el.style.display = "none";
  document.body.appendChild(el);
  return el;
}
const inputImagem = criarInputImagem();
function lerImagemLocal(file) {
  return new Promise((ok, nok) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = nok;
    r.readAsDataURL(file);
  });
}
const cats = ["alimentos", "bebidas", "limpeza", "panificacao"];
function ph(p, m = "Indisponivel") {
  return '<div class="ph"><b>' + es(m) + "</b><span>" + es(p.descricao) + "</span></div>";
}
function cardHtml(p, modoEdit) {
  const obsExibir = p.observacao ? '<div class="obs-exibir">' + es(p.observacao) + "</div>" : "";
  const img = p.imagem
    ? '<img src="' + es(p.imagem) + '" alt="' + es(p.descricao) + '">'
    : ph(p, p.estado === "buscando" ? "Buscando..." : "Imagem nao encontrada");
  if (modoEdit) {
    return '<article class="pr" data-id="' + p.id + '">' +
      '<button class="ed" type="button" data-ai="' + p.id + '">Alterar imagem</button>' +
      '<button class="ex" type="button" data-ex="' + p.id + '">Excluir</button>' +
      '<div class="img-a">' + img + "</div>" + obsExibir +
      '<div class="inf"><div class="desc">' + es(p.descricao) + "</div>" +
      (p.embalagem ? '<div class="emb">' + es(p.embalagem) + "</div>" : "") +
      '<div class="obs-area"><textarea placeholder="Obs.: sabores, variacoes..." data-obs="' + p.id + '" maxlength="200">' + (p.observacao || "") + "</textarea></div></div>" +
      '<div class="rod-p"><div class="precos"><input class="pre-ed" type="text" value="' + es(p.preco) + '" data-preco="' + p.id + '"></div></div>' +
      '<div class="cod">Cod. ' + es(p.codigo || "000") + "</div></article>";
  }
  return '<article class="pr" data-id="' + p.id + '">' +
    '<div class="img-a">' + img + "</div>" + obsExibir +
    '<div class="inf"><div class="desc">' + es(p.descricao) + "</div>" +
    (p.embalagem ? '<div class="emb">' + es(p.embalagem) + "</div>" : "") +
    "</div>" +
    '<div class="rod-p"><div class="precos"><span class="pre-final">' + es(p.preco) + "</span></div></div></article>";
}
function rdr() {
  const mc = editando ? "edit-mode" : "final-mode";
  gr.className = "gr " + mc;
  if (!prods.length) {
    gr.innerHTML = '<div class="vz"><strong>Nenhum produto adicionado</strong>Digite os itens e clique em "Adicionar".</div>';
    return;
  }
  gr.innerHTML = prods.map(p => cardHtml(p, editando)).join("");
}
on(gr, "click", e => {
  const ai = e.target.closest("[data-ai]");
  if (ai) { abrirImgModal(Number(ai.dataset.ai)); return; }
  const ex = e.target.closest("[data-ex]");
  if (ex) excluir(Number(ex.dataset.ex));
});
on(gr, "input", e => {
  const obs = e.target.closest("[data-obs]");
  if (obs) gn(Number(obs.dataset.obs), obs.value);
});
on(gr, "change", e => {
  const pre = e.target.closest("[data-preco]");
  if (pre) altPreco(Number(pre.dataset.preco), pre.value);
});
function ti(u, t = 8e3) {
  return new Promise(r => {
    const i = new Image(), s = setTimeout(() => { i.src = ""; r(false); }, t);
    i.onload = () => { clearTimeout(s); r(i.naturalWidth > 20 && i.naturalHeight > 20); };
    i.onerror = () => { clearTimeout(s); r(false); };
    i.src = u + (u.includes("?") ? "&" : "?") + "v=" + Date.now();
  });
}
function tr(t) {
  const s = new Set(["DE", "DA", "DO", "DAS", "DOS", "COM", "SEM", "PARA", "EM", "E", "UN", "UND", "ML", "G", "KG", "LT", "L"]);
  return n(t).match(/[A-Z0-9]+/g)?.filter(x => x.length > 2 && !s.has(x)) || [];
}
async function bc(p) {
  const t = tr(p.descricao);
  if (!t.length) return "";
  for (const c of cats) {
    try {
      const r = await fetch("https://www.wilso.com.br/" + c, { mode: "cors" });
      if (!r.ok) continue;
      const h = await r.text(), d = new DOMParser().parseFromString(h, "text/html"), el = [...d.querySelectorAll("article,li,.product,.produto,[class*=product],[class*=produto]")];
      let ml = null, pt = 0;
      for (const e of el) {
        const tx = n(e.textContent), sc = t.filter(x => tx.includes(x)).length, im = e.querySelector("img");
        if (im && sc > pt) { ml = im; pt = sc; }
      }
      if (ml && pt >= Math.max(1, Math.ceil(t.length * .45))) {
        let sr = ml.getAttribute("src") || ml.getAttribute("data-src") || ml.getAttribute("data-lazy-src") || "";
        if (sr) {
          sr = new URL(sr, "https://www.wilso.com.br").href;
          if (await ti(sr)) return sr;
        }
      }
    } catch (e) {}
  }
  return "";
}
async function copiarImagem(url) {
  if (!url) return "";
  if (String(url).startsWith("/uploads/") || String(url).startsWith("data:")) return url;
  try {
    const up = await api("/api/fetch-image", { method: "POST", body: JSON.stringify({ url }) });
    return up.url || url;
  } catch (e) {
    return url;
  }
}
async function lc2(p) {
  p.estado = "buscando";
  rdr();
  let found = "";
  if (p.codigo && p.codigo !== "000") {
    const d = "https://wilso.agilecdn.com.br/" + encodeURIComponent(p.codigo) + ".jpg";
    if (await ti(d)) found = d;
  }
  if (!found) found = await bc(p);
  if (found) {
    p.imagem = await copiarImagem(found);
    p.estado = "encontrada";
  } else {
    p.imagem = "";
    p.estado = "ausente";
  }
  rdr();
  return !!found;
}
async function bt() {
  bus.disabled = 1;
  finalBtn.disabled = 1;
  for (let i = 0; i < prods.length; i++) {
    setStatus("Buscando: " + (i + 1) + "/" + prods.length + " - " + prods[i].descricao);
    await lc2(prods[i]);
  }
  const ac = prods.filter(p => p.estado === "encontrada").length, fa = prods.length - ac;
  setStatus("Pronto: " + prods.length + " produtos, " + ac + " imagens, " + fa + " reservas.", "ok");
  bus.disabled = 0;
  finalBtn.disabled = 0;
  agendarSalvar();
}
function gn(id, val) {
  const p = prods.find(x => x.id === id);
  if (p) { p.observacao = val; agendarSalvar(); }
}
function excluir(id) {
  const idx = prods.findIndex(p => p.id === id);
  if (idx >= 0) { prods.splice(idx, 1); rdr(); agendarSalvar(); }
}
function altPreco(id, val) {
  const p = prods.find(x => x.id === id);
  if (p) { p.preco = md(val); rdr(); agendarSalvar(); }
}
function abrirImgModal(id) {
  imgTargetId = id;
  const p = prods.find(x => x.id === id);
  $("#imgQuery").value = p ? p.descricao : "";
  $("#imgSt").textContent = "";
  $("#imgGrid").innerHTML = "";
  $("#imgModal").classList.add("on");
}
function fecharImgModal() {
  $("#imgModal").classList.remove("on");
}
async function aplicarImagemProduto(url) {
  const p = prods.find(x => x.id === imgTargetId);
  if (!p || !url) return;
  setStatus("Salvando imagem...");
  $("#imgSt").textContent = "Salvando imagem...";
  try {
    p.imagem = await copiarImagem(url);
    p.estado = "encontrada";
    setStatus("Imagem atualizada.", "ok");
    rdr();
    agendarSalvar();
    fecharImgModal();
  } catch (e) {
    $("#imgSt").textContent = "Não foi possível usar esta imagem.";
    setStatus("Não carregou.", "err");
  }
}
on("#imgCancel", "click", fecharImgModal);
on("#imgFileBtn", "click", () => {
  const p = prods.find(x => x.id === imgTargetId);
  if (!p) return;
  inputImagem.onchange = async () => {
    const f = inputImagem.files[0];
    if (!f) return;
    const dataUrl = await lerImagemLocal(f);
    setStatus("Enviando imagem...");
    try {
      const up = await api("/api/upload", { method: "POST", body: JSON.stringify({ image: dataUrl }) });
      p.imagem = up.url;
      setStatus("Imagem salva.", "ok");
    } catch (e) {
      p.imagem = dataUrl;
      setStatus("Imagem no aparelho, mas não ficou salva no servidor: " + e.message, "err");
    }
    p.estado = "encontrada";
    rdr();
    agendarSalvar();
    inputImagem.value = "";
    fecharImgModal();
  };
  inputImagem.click();
});
on("#imgSearchBtn", "click", async () => {
  const q = $("#imgQuery").value.trim();
  if (q.length < 2) { $("#imgSt").textContent = "Informe o nome do produto."; return; }
  $("#imgSt").textContent = "Buscando imagens...";
  $("#imgGrid").innerHTML = "";
  $("#imgSearchBtn").disabled = true;
  try {
    const data = await api("/api/search-images", { method: "POST", body: JSON.stringify({ q }) });
    const images = data.images || [];
    if (!images.length) {
      $("#imgSt").textContent = "Nenhuma imagem encontrada. Tente outro nome.";
      return;
    }
    $("#imgSt").textContent = images.length + " imagem(ns). Clique para usar.";
    $("#imgGrid").innerHTML = images.map(img =>
      '<button type="button" data-img="' + es(img.url) + '"><img src="' + es(img.thumb || img.url) + '" alt=""></button>'
    ).join("");
  } catch (e) {
    $("#imgSt").textContent = e.message || "Falha na busca.";
  } finally {
    $("#imgSearchBtn").disabled = false;
  }
});
on("#imgGrid", "click", e => {
  const btn = e.target.closest("[data-img]");
  if (btn) aplicarImagemProduto(btn.dataset.img);
});
on("#imgQuery", "keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    const btn = $("#imgSearchBtn");
    if (btn) btn.click();
  }
});

function produtoDeParsed(p) {
  let descricao = String(p.descricao || "").replace(/\s+/g, " ").trim();
  if (!descValida(descricao, p.codigo)) return null;
  idCounter++;
  return {
    id: idCounter,
    codigo: codigoFinal(p.codigo),
    descricao: descricao.toUpperCase(),
    embalagem: "",
    preco: md(p.preco),
    imagem: "",
    estado: "aguardando",
    observacao: ""
  };
}
function jaExiste(p) {
  const nd = n(p.descricao);
  return prods.some(x => {
    if (p.codigo !== "000" && x.codigo === p.codigo) return true;
    if (n(x.descricao) === nd) return true;
    return ehFragmentoDe(p.descricao, x.descricao) || ehFragmentoDe(x.descricao, p.descricao);
  });
}
function adicionarLista(novosRaw, origem) {
  const novos = [];
  for (const p of novosRaw) {
    const item = produtoDeParsed(p);
    if (item) novos.push(item);
  }
  const unicos = novos.filter(p => !jaExiste(p));
  if (!unicos.length) {
    setStatus(novos.length ? "Produtos já estavam na lista" + (origem ? " (" + origem + ")" : "") + "." : "Nenhum produto válido" + (origem ? " em " + origem : "") + ". Use UNIT como preço e ignore EMBAL/MASTER.");
    return 0;
  }
  const limite = maxProducts();
  let aceitos = unicos;
  if (limite && prods.length + unicos.length > limite) {
    const vagas = Math.max(0, limite - prods.length);
    aceitos = unicos.slice(0, vagas);
    if (!aceitos.length) {
      setStatus("Plano gratuito permite até " + limite + " produtos. Assine o Pro para adicionar mais.", "err");
      return 0;
    }
  }
  prods = prods.concat(aceitos);
  rdr();
  bus.disabled = 0;
  finalBtn.disabled = 0;
  const extra = aceitos.length < unicos.length ? " Limite gratuito atingido (" + limite + ")." : "";
  setStatus(aceitos.length + " produto(s) adicionados" + (origem ? " de " + origem : "") + ". Total: " + prods.length + "." + extra, extra ? "err" : "ok");
  agendarSalvar();
  return aceitos.length;
}
function loadScript(src) {
  return new Promise((ok, nok) => {
    if ([...document.scripts].some(s => s.src === src)) return ok();
    const s = document.createElement("script");
    s.src = src;
    s.onload = ok;
    s.onerror = () => nok(new Error("Falha ao carregar " + src));
    document.head.appendChild(s);
  });
}
async function garantirTesseract() {
  if (window.Tesseract) return;
  setStatus("Carregando leitor de imagem...");
  await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js");
}
function itensParaLinhas(items) {
  const valid = items.filter(i => i.str && i.str.trim());
  valid.sort((a, b) => {
    const ya = a.transform[5], yb = b.transform[5];
    if (Math.abs(ya - yb) > 3) return yb - ya;
    return a.transform[4] - b.transform[4];
  });
  const linhas = [];
  let cur = [], curY = null;
  for (const it of valid) {
    const y = it.transform[5];
    if (curY === null || Math.abs(y - curY) <= 3.5) {
      cur.push(it.str);
      if (curY === null) curY = y;
    } else {
      linhas.push(cur.join(" ").replace(/\s+/g, " ").trim());
      cur = [it.str];
      curY = y;
    }
  }
  if (cur.length) linhas.push(cur.join(" ").replace(/\s+/g, " ").trim());
  return linhas;
}
async function abrirPdf(buf) {
  if (!window.pdfjsLib) throw new Error("Biblioteca de PDF não carregou. Verifique a internet.");
  try {
    return await pdfjsLib.getDocument({ data: buf }).promise;
  } catch (e) {
    pdfjsLib.disableWorker = true;
    return await pdfjsLib.getDocument({ data: buf, disableWorker: true }).promise;
  }
}
async function ocrCanvas(canvas, rotulo) {
  await garantirTesseract();
  setStatus("OCR " + rotulo + "...");
  const worker = await Tesseract.createWorker("por");
  try {
    const { data } = await worker.recognize(canvas);
    return data.text || "";
  } finally {
    await worker.terminate();
  }
}
async function renderPaginaCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas;
}
async function extrairTextoPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await abrirPdf(buf);
  let linhas = [], cru = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    setStatus("Lendo PDF " + file.name + " — pagina " + i + "/" + pdf.numPages);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    linhas.push(...itensParaLinhas(content.items));
    cru.push(...content.items.map(it => it.str));
  }
  let texto = linhas.join("\n") + "\n" + cru.join("\n");
  let novos = parseLinhas(texto);
  if (novos.length >= 3) return { texto, novos };
  setStatus("PDF sem tabela clara. Tentando OCR...");
  let ocr = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const canvas = await renderPaginaCanvas(page, 2);
    ocr += "\n" + await ocrCanvas(canvas, "pagina " + i + "/" + pdf.numPages);
  }
  texto += "\n" + ocr;
  return { texto, novos: parseLinhas(texto) };
}
async function extrairTextoImagem(file) {
  setStatus("Lendo imagem " + file.name + "...");
  const url = await lerImagemLocal(file);
  const img = await new Promise((ok, nok) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = nok;
    i.src = url;
  });
  const canvas = document.createElement("canvas");
  const maxW = 1800;
  const scale = img.width > maxW ? maxW / img.width : 1;
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const texto = await ocrCanvas(canvas, file.name);
  return { texto, novos: parseLinhas(texto) };
}
async function processarArquivos(files) {
  if (!files || !files.length) return;
  addBtn.disabled = 1;
  bus.disabled = 1;
  finalBtn.disabled = 1;
  let soma = 0;
  for (const file of files) {
    try {
      const tipo = (file.type || "").toLowerCase();
      const nome = file.name.toLowerCase();
      const isPdf = tipo === "application/pdf" || nome.endsWith(".pdf");
      const isImg = tipo.startsWith("image/") || /\.(png|jpe?g|webp|bmp)$/.test(nome);
      if (!isPdf && !isImg) {
        setStatus("Arquivo ignorado: " + file.name);
        continue;
      }
      const { novos } = isPdf ? await extrairTextoPdf(file) : await extrairTextoImagem(file);
      soma += adicionarLista(novos, file.name);
    } catch (e) {
      setStatus("Falha ao ler " + file.name + ": " + (e.message || e), "err");
    }
  }
  addBtn.disabled = 0;
  if (prods.length) { bus.disabled = 0; finalBtn.disabled = 0; }
  if (soma) setStatus("Importação concluída: " + soma + " produto(s). Total: " + prods.length + ".", "ok");
}
on(addBtn, "click", () => {
  const texto = inp.value.trim();
  if (!texto) { setStatus("Cole, digite ou suba um PDF/imagem primeiro."); return; }
  const novos = parseLinhas(texto);
  if (adicionarLista(novos, "")) inp.value = "";
});
on(upz, "click", () => arq && arq.click());
on(upz, "dragover", e => { e.preventDefault(); upz.classList.add("over"); });
on(upz, "dragleave", () => upz.classList.remove("over"));
on(upz, "drop", e => {
  e.preventDefault();
  upz.classList.remove("over");
  processarArquivos([...e.dataTransfer.files]);
});
on(arq, "change", () => {
  processarArquivos([...arq.files]);
  arq.value = "";
});
on("#atu", "click", () => {
  $("#titS").textContent = $("#tit").value.trim() || "OFERTAS";
  $("#perS").textContent = $("#per").value.trim();
  agendarSalvar();
});
on("#docSel", "change", async () => {
  if (currentDocId) await salvarAgora();
  await carregarCatalogo(Number($("#docSel").value));
});
on("#docNew", "click", async () => {
  if (maxCatalogs() && docsCache.length >= maxCatalogs()) {
    setStatus("Plano gratuito permite 1 catálogo. Assine o Pro para criar mais.", "err");
    return;
  }
  const name = prompt("Nome do catálogo:", "Novo catálogo");
  if (!name) return;
  if (currentDocId) await salvarAgora();
  try {
    const created = await api("/api/catalogs", { method: "POST", body: JSON.stringify({ name, title: "OFERTAS", layout: layoutAtual || "" }) });
    await listarDocs();
    await carregarCatalogo(created.id);
    abrirLayoutModal();
  } catch (e) {
    setStatus(e.message, "err");
  }
});
on("#docDup", "click", async () => {
  if (!currentDocId) return;
  if (maxCatalogs() && docsCache.length >= maxCatalogs()) {
    setStatus("Plano gratuito permite 1 catálogo. Assine o Pro para duplicar.", "err");
    return;
  }
  try {
    await salvarAgora();
    const created = await api("/api/catalogs/" + currentDocId + "/duplicate", { method: "POST", body: "{}" });
    await listarDocs();
    await carregarCatalogo(created.id);
  } catch (e) {
    setStatus(e.message, "err");
  }
});
on("#docDel", "click", async () => {
  if (!currentDocId) return;
  if (!confirm("Excluir este catálogo?")) return;
  try {
    await api("/api/catalogs/" + currentDocId, { method: "DELETE" });
    currentDocId = 0;
    await listarDocs();
    await carregarCatalogo(currentDocId);
  } catch (e) {
    setStatus(e.message, "err");
  }
});
on(bus, "click", bt);

async function garantirImagensLocais() {
  let nImg = 0;
  for (const p of prods) {
    const img = String(p.imagem || "");
    if (!img || img.startsWith("/uploads/") || img.startsWith("data:")) continue;
    setStatus("Copiando imagem " + (++nImg) + " para o PDF...");
    p.imagem = await copiarImagem(img);
  }
  if (nImg) agendarSalvar();
}
function esperarImagens(root) {
  const imgs = [...(root || document).querySelectorAll("img")];
  return Promise.all(imgs.map(im => im.complete && im.naturalWidth ? Promise.resolve() : new Promise(r => {
    im.onload = () => r();
    im.onerror = () => r();
    setTimeout(r, 8000);
  })));
}
async function blobParaDataUrl(blob) {
  return await new Promise((ok, nok) => {
    const fr = new FileReader();
    fr.onload = () => ok(fr.result);
    fr.onerror = nok;
    fr.readAsDataURL(blob);
  });
}
async function imagemParaDataUrl(src) {
  if (!src) return "";
  if (String(src).startsWith("data:")) return src;
  try {
    const r = await fetch(src, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) throw new Error("http");
    return await blobParaDataUrl(await r.blob());
  } catch (e) {
    try {
      const up = await copiarImagem(src);
      if (up && up.startsWith("/uploads/")) {
        const r2 = await fetch(up, { credentials: "same-origin", cache: "no-store" });
        if (r2.ok) return await blobParaDataUrl(await r2.blob());
      }
    } catch (err) {}
  }
  return src;
}
async function incorporarImagens(root) {
  const imgs = [...root.querySelectorAll("img")];
  let nImg = 0;
  for (const im of imgs) {
    const src = im.currentSrc || im.getAttribute("src") || "";
    if (!src || src.startsWith("data:")) continue;
    setStatus("Preparando foto " + (++nImg) + "/" + imgs.length + " para o PDF...");
    const data = await imagemParaDataUrl(src);
    if (data && data.startsWith("data:")) im.src = data;
  }
}
function paginarProdutos(lista) {
  if (!lista.length) return [];
  const pages = [lista.slice(0, CARDS_PER_PAGE)];
  const resto = lista.slice(CARDS_PER_PAGE);
  const extra = 12;
  for (let i = 0; i < resto.length; i += extra) pages.push(resto.slice(i, i + extra));
  return pages;
}
function montarPaginaPdf(grupo, pageIndex, totalPages) {
  const page = document.createElement("div");
  const comTopo = pageIndex === 0;
  page.className = "pdf-page cat" + (comTopo ? "" : " no-topo") + (layoutAtual && LAYOUTS[layoutAtual] ? " " + LAYOUTS[layoutAtual].cls : "");
  page.style.position = "fixed";
  page.style.left = "-9999px";
  page.style.top = "0";
  const topo = comTopo
    ? '<div class="topo"><h2>' + es($("#tit").value.trim() || "OFERTAS") + '</h2><div class="sub">' + es($("#per").value.trim()) + "</div></div>"
    : "";
  page.innerHTML =
    topo +
    '<div class="gr final-mode">' + grupo.map(p => cardHtml(p, false)).join("") + "</div>" +
    '<div class="rodape"><span>*Imagens meramente ilustrativas</span></div>';
  document.body.appendChild(page);
  return page;
}
async function gerarPdf() {
  if (!prods.length) { setStatus("Adicione produtos antes de gerar o PDF."); return; }
  $("#titS").textContent = $("#tit").value.trim() || "OFERTAS";
  $("#perS").textContent = $("#per").value.trim();
  finalBtn.disabled = 1;
  try { await garantirImagensLocais(); } catch (e) {}
  if (!window.html2canvas || !window.jspdf) {
    const prev = editando;
    editando = false;
    rdr();
    setTimeout(() => window.print(), 200);
    editando = prev;
    rdr();
    finalBtn.disabled = 0;
    return;
  }
  setStatus("Gerando PDF...");
  const grupos = paginarProdutos(prods);
  const paginas = [];
  try {
    for (let i = 0; i < grupos.length; i++) {
      const page = montarPaginaPdf(grupos[i], i, grupos.length);
      paginas.push(page);
      try { await incorporarImagens(page); } catch (e) {}
      await esperarImagens(page);
    }
    const jsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageW = 210, pageH = 297;
    for (let i = 0; i < paginas.length; i++) {
      setStatus("Gerando PDF... pagina " + (i + 1) + "/" + paginas.length);
      const canvas = await html2canvas(paginas[i], {
        scale: 2,
        useCORS: true,
        allowTaint: false,
        backgroundColor: "#ffffff",
        logging: false,
        imageTimeout: 15000,
        width: paginas[i].offsetWidth,
        height: paginas[i].offsetHeight
      });
      const img = canvas.toDataURL("image/jpeg", 0.92);
      if (i) pdf.addPage();
      pdf.addImage(img, "JPEG", 0, 0, pageW, pageH);
    }
    const nome = ($("#tit").value.trim() || "catalogo").replace(/[^\w\-]+/g, "_");
    pdf.save(nome + ".pdf");
    setStatus("PDF baixado (" + paginas.length + " pagina" + (paginas.length > 1 ? "s" : "") + ").", "ok");
  } catch (e) {
    setStatus("Falha no PDF, abrindo impressão. " + (e.message || ""), "err");
    window.print();
  }
  paginas.forEach(p => p.remove());
  finalBtn.disabled = 0;
}
on(finalBtn, "click", gerarPdf);
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
boot();
