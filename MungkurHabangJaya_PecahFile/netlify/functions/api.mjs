import { getStore } from "@netlify/blobs";
import webpush from "web-push";
import crypto from "node:crypto";

const st = () => getStore("toko");
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const rd = async (k, d) => (await st().get(k, { type: "json" })) ?? d;
const wr = (k, v) => st().setJSON(k, v);
const ROLES = ["kasir", "owner", "gudang"];
const hash = (p, salt) => crypto.scryptSync(p, salt, 32).toString("hex");
const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (cfg, o) => { const p = b64(JSON.stringify(o)); return p + "." + crypto.createHmac("sha256", cfg.jwt).update(p).digest("base64url"); };

async function getCfg() {
  let c = await rd("config", null);
  if (!c) { c = { jwt: crypto.randomBytes(32).toString("hex"), vapid: webpush.generateVAPIDKeys() }; await wr("config", c); }
  return c;
}
function auth(req, cfg) {
  const t = (req.headers.get("authorization") || "").replace("Bearer ", "");
  const [p, s] = t.split(".");
  if (!p || !s) return null;
  const ok = crypto.createHmac("sha256", cfg.jwt).update(p).digest("base64url");
  if (s.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(ok))) return null;
  try { const o = JSON.parse(Buffer.from(p, "base64url").toString()); return o.e > Date.now() ? o : null; } catch { return null; }
}
async function pushAll(cfg, payload) {
  webpush.setVapidDetails("mailto:admin@example.com", cfg.vapid.publicKey, cfg.vapid.privateKey);
  const subs = await rd("subs", []); const keep = [];
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 86400, urgency: "high" }); keep.push(s); }
    catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) keep.push(s); }
  }));
  await wr("subs", keep);
}
const token = (cfg, u) => sign(cfg, { u: u.u, r: u.r, e: Date.now() + 30 * 864e5 });
const str = (v, n) => String(v ?? "").slice(0, n);

export default async (req) => {
  try {
    const path = new URL(req.url).pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
    const url = new URL(req.url);
    const m = req.method;
    let body = {};
    if (m !== "GET") { try { body = await req.json(); } catch {} }
    const cfg = await getCfg();
    const me = auth(req, cfg);
    const users = await rd("users", []);

    if (path === "status") return J({ setup: users.length > 0 });
    if (path === "vapid") return J({ key: cfg.vapid.publicKey });

    if (path === "setup" && m === "POST") {
      if (users.length) return J({ error: "Sudah ada akun admin." }, 403);
      const u = str(body.user, 30).trim().toLowerCase();
      if (!u || str(body.pass, 100).length < 6) return J({ error: "Username wajib, password minimal 6 karakter." }, 400);
      const salt = crypto.randomBytes(16).toString("hex");
      const adm = { u, r: "admin", salt, h: hash(body.pass, salt) };
      await wr("users", [adm]);
      return J({ token: token(cfg, adm), user: { u, r: "admin" } });
    }
    if (path === "login" && m === "POST") {
      const u = users.find((x) => x.u === str(body.user, 30).trim().toLowerCase());
      if (!u || hash(str(body.pass, 100), u.salt) !== u.h) return J({ error: "Username atau password salah." }, 401);
      return J({ token: token(cfg, u), user: { u: u.u, r: u.r } });
    }

    if (path === "public") {
      const d = await rd("data", { v: 0, kv: {} });
      let b = []; try { b = JSON.parse(d.kv.tb_master_barang || "[]"); } catch {}
      return J({ barang: b.map((x) => ({ nama: x.nama, harga: x.harga, kategori: x.kategori, satuan: x.satuan, stok: x.stok })) });
    }
    if (path === "order" && m === "POST") {
      const o = body.order || {};
      if (!o.nomor || !o.nama || !Array.isArray(o.items) || o.items.length > 200) return J({ error: "Pesanan tidak valid." }, 400);
      const orders = await rd("orders", []);
      if (!orders.some((x) => x.nomor === o.nomor)) {
        orders.push({ nomor: str(o.nomor, 40), nama: str(o.nama, 80), hp: str(o.hp, 30), alamat: str(o.alamat, 300), tanggal: str(o.tanggal, 40), total: Number(o.total) || 0, catatan: str(o.catatan, 500), items: o.items.map((i) => ({ nama: str(i.nama, 120), q: Number(i.q) || 0, s: str(i.s, 20), h: Number(i.h) || 0, sub: Number(i.sub) || 0 })), status: "Menunggu konfirmasi", dibuat: new Date().toISOString() });
        await wr("orders", orders.slice(-500));
        await pushAll(cfg, { title: "🛒 Pesanan tamu baru", body: str(o.nama, 40) + " · " + str(o.nomor, 40), tag: o.nomor });
      }
      return J({ ok: true });
    }
    if (path === "track") {
      const o = (await rd("orders", [])).find((x) => x.nomor === url.searchParams.get("no"));
      return o ? J({ status: o.status, diubah: o.diubah || o.dibuat }) : J({ error: "Nomor pesanan tidak ditemukan." }, 404);
    }

    if (!me) return J({ error: "Belum login." }, 401);
    const cur = users.find((x) => x.u === me.u);
    if (!cur) return J({ error: "Akun sudah dihapus." }, 401);
    const role = cur.r;
    if (path === "me") return J({ u: cur.u, r: role });

    if (path === "users") {
      if (role !== "admin") return J({ error: "Khusus admin." }, 403);
      if (m === "GET") return J({ users: users.map((x) => ({ u: x.u, r: x.r })) });
      if (m === "POST") {
        const u = str(body.user, 30).trim().toLowerCase();
        if (!/^[a-z0-9_.-]{3,30}$/.test(u)) return J({ error: "Username 3-30 karakter (huruf/angka)." }, 400);
        if (!ROLES.includes(body.role)) return J({ error: "Peran tidak valid." }, 400);
        if (str(body.pass, 100).length < 6) return J({ error: "Password minimal 6 karakter." }, 400);
        if (users.some((x) => x.u === u)) return J({ error: "Username sudah dipakai." }, 400);
        const salt = crypto.randomBytes(16).toString("hex");
        users.push({ u, r: body.role, salt, h: hash(body.pass, salt) });
        await wr("users", users); return J({ ok: true });
      }
      if (m === "DELETE") {
        const t = users.find((x) => x.u === body.user);
        if (!t || t.r === "admin") return J({ error: "Akun admin tidak bisa dihapus." }, 400);
        await wr("users", users.filter((x) => x.u !== t.u)); return J({ ok: true });
      }
    }

    if (path === "data") {
      const d = await rd("data", { v: 0, kv: {} });
      if (m === "GET") return Number(url.searchParams.get("v")) === d.v ? J({ same: true, v: d.v }) : J(d);
      if (m === "PUT") {
        if (role === "gudang") return J({ error: "Peran gudang hanya bisa melihat." }, 403);
        for (const [k, v] of Object.entries(body.kv || {})) {
          if (!/^(tb_|mh_)/.test(k)) continue;
          if (v === null) delete d.kv[k]; else d.kv[k] = String(v);
        }
        d.v += 1; await wr("data", d); return J({ v: d.v });
      }
    }
    if (path === "orders") return J({ orders: await rd("orders", []) });
    if (path === "order-status" && m === "POST") {
      if (role === "gudang") return J({ error: "Tidak diizinkan." }, 403);
      const orders = await rd("orders", []); const o = orders.find((x) => x.nomor === body.nomor);
      if (!o) return J({ error: "Tidak ditemukan." }, 404);
      o.status = str(body.status, 40); o.diubah = new Date().toISOString();
      await wr("orders", orders); return J({ ok: true });
    }
    if (path === "push" && m === "POST") {
      const sub = body.sub; if (!sub || !sub.endpoint) return J({ error: "Langganan tidak valid." }, 400);
      const subs = (await rd("subs", [])).filter((s) => s.sub.endpoint !== sub.endpoint);
      subs.push({ u: cur.u, sub }); await wr("subs", subs); return J({ ok: true });
    }
    if (path === "notify" && m === "POST") {
      if (role === "gudang") return J({ error: "Tidak diizinkan." }, 403);
      await pushAll(cfg, { title: str(body.title, 80), body: str(body.body, 200), tag: "nota" });
      return J({ ok: true });
    }
    return J({ error: "Endpoint tidak ada." }, 404);
  } catch (e) {
    return J({ error: "Server error: " + (e && e.message) }, 500);
  }
};
export const config = { path: "/api/*" };
