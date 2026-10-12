const EMBAL_RE = /\b((?:FD|CX|UN|SC|BD|DP|PT|PC|PCT|CT|DZ)-\d{1,4})\b/i;
const EMBAL_ONLY = /^(?:FD|CX|UN|SC|BD|DP|PT|PC|PCT|CT|DZ)-\d{1,4}$/i;
const PRECO_RE = /^(?:\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})$/;
const PRECO_CAP = /(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/g;
const SKIP_LINHA = /^(cod|c[oó]digo|descri[cç][aã]o|embal|unit|master|promo[cç][aã]o.*|ofertas?)$/i;
const SKIP_DESC = /^(cod|c[oó]digo|descri[cç][aã]o|produto|pre[cç]o|embal|unit|master)$/i;
const FRAG_DESC = /^(c\/\d+|\d+u|\d+un|prom|un|cx|fd|kg|ml|l|g|pt|sc|bd)$/i;

function n(v) {
  return String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function lc(v) {
  return String(v ?? "").trim().replace(/\.0$/, "").replace(/[^\w-]/g, "");
}
function codigoFinal(c) {
  const x = lc(c);
  return x && x !== "0" ? x : "000";
}
function md(v) {
  let s = String(v ?? "").trim().replace(/[R$\s]/g, "");
  if (!s) return "R$ 0,00";
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = s.replace(",", ".");
  const num = Number(s);
  return Number.isFinite(num) ? num.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : String(v);
}
function es(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function parecePreco(s) {
  s = String(s ?? "").trim().replace(/^R\$\s*/i, "").replace(/\s/g, "");
  if (!s) return false;
  return /^(?:\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+\.\d{2}|\d+)$/.test(s);
}
function extrairPrecoDoFim(linha) {
  const m = String(linha).match(/\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+\.\d{2})\s*$/i);
  if (!m) return null;
  return { preco: m[1], resto: linha.slice(0, m.index).trim() };
}
function splitCodDesc(s) {
  s = String(s ?? "").trim().replace(/^[\-–—|]+/, "").replace(/[\-–—|]+$/, "").trim();
  const m = s.match(/^(\d{1,6})\s+(.+)$/);
  if (m) return { codigo: m[1], descricao: m[2].trim() };
  return { codigo: "000", descricao: s };
}
function descValida(descricao, codigo) {
  const d = String(descricao || "").replace(/\s+/g, " ").trim().replace(/^[,;|.\-–—\s]+/, "").replace(/[,;|.\-–—\s]+$/, "");
  if (d.length < 4) return false;
  if (SKIP_DESC.test(d) || FRAG_DESC.test(d) || SKIP_LINHA.test(d)) return false;
  if (!/[A-Za-zÁ-ú]{3,}/.test(d)) return false;
  const words = d.split(/\s+/).filter(w => /[A-Za-zÁ-ú]{2,}/.test(w));
  if (!words.length) return false;
  if (codigoFinal(codigo) === "000" && /^(ao|branca?o|preto|com|de|da|do|das|dos|para|em|c\/\d+|prom|un|cx)\b/i.test(d)) return false;
  return true;
}
function parseLinhaTabela(linha) {
  if (/descri/i.test(linha) && /embal/i.test(linha)) return null;
  const m = linha.match(EMBAL_RE);
  if (!m) return null;
  const after = linha.slice(m.index + m[0].length);
  const precos = [];
  let x;
  const re = new RegExp(PRECO_CAP.source, "g");
  while ((x = re.exec(after))) precos.push(x[1]);
  if (!precos.length) return null;
  const before = linha.slice(0, m.index).trim().replace(/[\-–—|;]+$/, "").trim();
  if (!before) return null;
  const { codigo, descricao } = splitCodDesc(before);
  if (!descValida(descricao, codigo)) return null;
  return { codigo, descricao, preco: precos[0] };
}
function parseLinhaLivre(linha) {
  if (EMBAL_RE.test(linha)) return null;
  const extraido = extrairPrecoDoFim(linha);
  if (!extraido || !extraido.resto) return null;
  const { codigo, descricao } = splitCodDesc(extraido.resto);
  if (!descValida(descricao, codigo)) return null;
  return { codigo, descricao, preco: extraido.preco };
}
function parsePorSeparador(linha, sep) {
  const partes = linha.split(sep).map(p => p.trim());
  if (partes.length < 2) return null;
  if (partes.length === 2) {
    if (!parecePreco(partes[1]) && !extrairPrecoDoFim(partes[1])) return null;
    const { codigo, descricao } = splitCodDesc(partes[0]);
    if (!descValida(descricao, codigo)) return null;
    return { codigo, descricao, preco: partes[1] };
  }
  const preco = partes[partes.length - 1];
  const codigo = partes[0];
  const descricao = partes.slice(1, -1).join(typeof sep === "string" ? sep : " ").trim();
  if (!descValida(descricao, codigo)) return null;
  return { codigo: codigo || "000", descricao, preco };
}
function parseUmaLinha(linha) {
  linha = linha.trim();
  if (!linha || SKIP_LINHA.test(linha)) return null;
  const tab = parseLinhaTabela(linha);
  if (tab) return tab;
  if (linha.includes(";")) {
    const p = parsePorSeparador(linha, ";");
    if (p) return p;
  }
  if (linha.includes("\t")) {
    const p = parsePorSeparador(linha, "\t");
    if (p) return p;
  }
  if (/\s+[-–—]\s+/.test(linha)) {
    const viaTraco = parsePorSeparador(linha, /\s+[-–—]\s+/);
    if (viaTraco) return viaTraco;
  }
  return parseLinhaLivre(linha);
}
function parseCamposEmpilhados(texto) {
  const linhas = texto.split(/\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < linhas.length; i++) {
    if (!EMBAL_ONLY.test(linhas[i])) continue;
    const unit = linhas[i + 1] || "";
    const master = linhas[i + 2] || "";
    if (!PRECO_RE.test(unit)) continue;
    let desc = linhas[i - 1] || "";
    if (!desc || PRECO_RE.test(desc) || EMBAL_ONLY.test(desc) || SKIP_LINHA.test(desc)) continue;
    let codigo = "000";
    const prev = linhas[i - 2] || "";
    if (/^\d{1,6}$/.test(prev)) codigo = prev;
    if (!descValida(desc, codigo)) continue;
    out.push({ codigo, descricao: desc, preco: unit });
    if (PRECO_RE.test(master)) i += 2;
    else i += 1;
  }
  return out;
}
function parseTextoCorrido(texto) {
  const flat = texto.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");
  const re = /(?:^|\s)(\d{1,6})\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9][A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9\/.%+\- ]{6,70}?)\s+((?:FD|CX|UN|SC|BD|DP|PT)-\d{1,4})\s+(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\s+(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})(?=\s|$)/gi;
  const out = [];
  let m;
  while ((m = re.exec(flat))) {
    const desc = m[2].trim().replace(/\s+/g, " ");
    if (!descValida(desc, m[1])) continue;
    if (/\d+,\d{2}/.test(desc)) continue;
    if (desc.split(" ").length > 14) continue;
    out.push({ codigo: m[1], descricao: desc, preco: m[4] });
  }
  return out;
}
function ehTabela(texto) {
  const t = String(texto).toUpperCase();
  const hits = (t.match(/\b(?:FD|CX|UN|SC|BD|DP|PT)-\d+/g) || []).length;
  return /\bEMBAL\b|\bMASTER\b|\bUNIT\b/.test(t) || hits >= 3;
}
function ehFragmentoDe(curto, longo) {
  const a = String(curto).split(/\s+/).filter(Boolean);
  const b = String(longo).split(/\s+/).filter(Boolean);
  if (a.length >= b.length) return false;
  const sa = a.join(" "), sb = b.join(" ");
  return sb.startsWith(sa + " ") || sb.endsWith(" " + sa);
}
function dedupBrutos(brutos) {
  const limpos = [];
  for (const p of brutos) {
    if (!descValida(p.descricao, p.codigo)) continue;
    limpos.push({
      codigo: codigoFinal(p.codigo),
      descricao: String(p.descricao).replace(/\s+/g, " ").trim().toUpperCase(),
      preco: p.preco
    });
  }
  const porCod = new Map();
  const semCod = [];
  for (const p of limpos) {
    if (p.codigo !== "000") {
      const old = porCod.get(p.codigo);
      if (!old || p.descricao.length > old.descricao.length) porCod.set(p.codigo, p);
    } else semCod.push(p);
  }
  const lista = [...porCod.values(), ...semCod];
  const kept = [];
  const ordenados = [...lista].sort((a, b) => b.descricao.length - a.descricao.length);
  for (const p of ordenados) {
    const np = n(p.descricao);
    const dup = kept.some(k => {
      if (n(k.descricao) === np) return true;
      if (!ehFragmentoDe(p.descricao, k.descricao) && !ehFragmentoDe(k.descricao, p.descricao)) return false;
      return p.codigo === "000" || k.codigo === "000" || p.codigo === k.codigo;
    });
    if (dup) continue;
    kept.push(p);
  }
  const ordem = new Map(limpos.map((p, i) => [p.codigo + "|" + n(p.descricao), i]));
  kept.sort((a, b) => (ordem.get(a.codigo + "|" + n(a.descricao)) ?? 0) - (ordem.get(b.codigo + "|" + n(b.descricao)) ?? 0));
  return kept;
}
function parseLinhas(texto) {
  const brutos = [];
  for (const linha of String(texto).split(/\n/)) {
    const p = parseUmaLinha(linha);
    if (p) brutos.push(p);
  }
  if (ehTabela(texto)) {
    brutos.push(...parseCamposEmpilhados(texto));
    brutos.push(...parseTextoCorrido(texto));
  }
  return dedupBrutos(brutos);
}
