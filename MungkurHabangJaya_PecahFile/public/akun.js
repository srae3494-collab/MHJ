/* Lapisan login, sinkron database, dan notifikasi (Netlify Functions + Blobs) */
(function () {
  'use strict';
  var TK = 'auth_token', VK = 'auth_ver';
  var PUB = ['tabEstimasi', 'tabKatalog', 'tabTamu', 'tabLacak'];
  var KAS = ['tabNota', 'tabRiwayat', 'tabPiutang', 'tabEstimasi', 'tabKatalog', 'tabTamu', 'tabPesananTamu', 'tabLacak'];
  var TABS = { admin: null, owner: KAS.concat(['tabDashboard', 'tabLaporan', 'tabPersediaan', 'tabMaster']), kasir: KAS, gudang: ['tabRiwayat'], guest: PUB };
  var SKIP = /^(tb_tema|tb_bubble|tb_notif|tb_suara|tb_cadangan|tb_zap|tb_auto000)$/;
  var me = null, role = 'guest', applying = false, dirty = {}, tm = null;
  var STATUS = ['Menunggu konfirmasi', 'Diproses', 'Siap diambil', 'Dalam pengiriman', 'Selesai', 'Dibatalkan'];

  function syncKey(k) { return /^(tb_|mh_)/.test(k) && !SKIP.test(k) && k !== 'mh_pesanan_tamu'; }
  function ok(id) { var a = TABS[role]; return a === null || a.indexOf(id) >= 0 || (id === 'tabAkun' && role === 'admin'); }
  function api(p, o) {
    o = o || {}; var h = { 'Content-Type': 'application/json' }, t = localStorage.getItem(TK);
    if (t) h.Authorization = 'Bearer ' + t;
    return fetch('/api/' + p, { method: o.method || 'GET', headers: h, body: o.body ? JSON.stringify(o.body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && t) { localStorage.removeItem(TK); location.reload(); }
        if (!r.ok) throw new Error(j.error || 'Gagal (' + r.status + ')'); return j; }); });
  }
  function h(tag, p, kids) {
    var e = document.createElement(tag); p = p || {};
    Object.keys(p).forEach(function (k) { if (k === 'text') e.textContent = p[k]; else if (k.slice(0, 2) === 'on') e[k] = p[k]; else e.setAttribute(k, p[k]); });
    (kids || []).forEach(function (c) { e.appendChild(c); }); return e;
  }

  /* ---------- gaya ---------- */
  var css = document.createElement('style');
  css.textContent = '#akBar{position:fixed;top:8px;right:8px;z-index:9998;display:flex;gap:6px;align-items:center;background:rgba(15,23,42,.9);color:#fff;border-radius:20px;padding:5px 10px;font:600 12px system-ui}' +
    '#akBar button{border:0;border-radius:14px;padding:5px 10px;font:600 12px system-ui;cursor:pointer}' +
    '#akOv{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:16px}' +
    '#akOv .bx{background:#fff;color:#111;border-radius:14px;padding:20px;width:100%;max-width:340px;font:14px system-ui}' +
    '#akOv input,.akf input,.akf select{width:100%;box-sizing:border-box;padding:10px;margin:6px 0;border:1px solid #aaa;border-radius:8px;font-size:14px}' +
    '#akOv .go{width:100%;padding:11px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer}' +
    '.akerr{color:#c00;font-size:12px;min-height:16px}.akrow{display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid rgba(128,128,128,.3)}' +
    'body.role-gudang #tabRiwayat button:not([onclick*="cekUlangNota"]){display:none!important}';
  document.head.appendChild(css);

  /* ---------- login ---------- */
  function overlay(setup) {
    var u = h('input', { placeholder: 'Username', autocapitalize: 'none' }), p = h('input', { type: 'password', placeholder: 'Password (min. 6 karakter)' });
    var er = h('div', { class: 'akerr' });
    var go = h('button', { class: 'go', text: setup ? 'Buat Akun Admin' : 'Masuk' });
    var ov = h('div', { id: 'akOv' }, [h('div', { class: 'bx' }, [
      h('h3', { text: setup ? 'Buat akun admin pertama' : 'Masuk' }),
      h('div', { text: setup ? 'Akun ini punya semua akses.' : 'Gunakan akun yang dibuat admin.', style: 'font-size:12px;color:#555' }),
      u, p, er, go,
      h('button', { text: 'Batal', style: 'width:100%;margin-top:8px;border:0;background:none;color:#555;cursor:pointer', onclick: function () { ov.remove(); } })])]);
    go.onclick = function () {
      er.textContent = ''; go.disabled = true;
      api(setup ? 'setup' : 'login', { method: 'POST', body: { user: u.value, pass: p.value } }).then(function (r) {
        localStorage.setItem(TK, r.token); pushOn(true).then(function () { location.reload(); }, function () { location.reload(); });
      }).catch(function (e) { er.textContent = e.message; go.disabled = false; });
    };
    p.onkeydown = function (e) { if (e.key === 'Enter') go.onclick(); };
    document.body.appendChild(ov); u.focus();
  }
  function bar(setup) {
    var b = h('div', { id: 'akBar' });
    if (me) {
      b.appendChild(h('span', { text: '👤 ' + me.u + ' (' + me.r + ')' }));
      b.appendChild(h('button', { text: 'Keluar', onclick: function () { localStorage.removeItem(TK); localStorage.removeItem(VK); location.reload(); } }));
    } else b.appendChild(h('button', { text: setup ? 'Buat Admin' : 'Masuk', onclick: function () { overlay(setup); } }));
    document.body.appendChild(b);
  }

  /* ---------- sinkron ---------- */
  function localKv() { var o = {}; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (syncKey(k)) o[k] = localStorage.getItem(k); } return o; }
  function flush() {
    var kv = {}; Object.keys(dirty).forEach(function (k) { kv[k] = dirty[k] ? localStorage.getItem(k) : null; }); dirty = {};
    if (!Object.keys(kv).length) return;
    api('data', { method: 'PUT', body: { kv: kv } }).then(function (r) { localStorage.setItem(VK, r.v); }).catch(function () {});
  }
  function canWrite() { return me && role !== 'gudang'; }
  var os = Storage.prototype.setItem, orm = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k) { os.apply(this, arguments); if (!applying && this === localStorage && canWrite() && syncKey(k)) { dirty[k] = 1; clearTimeout(tm); tm = setTimeout(flush, 1500); } };
  Storage.prototype.removeItem = function (k) { orm.apply(this, arguments); if (!applying && this === localStorage && canWrite() && syncKey(k)) { dirty[k] = 0; clearTimeout(tm); tm = setTimeout(flush, 1500); } };

  function pull(first) {
    return api('data?v=' + (localStorage.getItem(VK) || -1)).then(function (r) {
      if (r.same) return;
      if (r.v === 0) { if (canWrite()) return api('data', { method: 'PUT', body: { kv: localKv() } }).then(function (x) { localStorage.setItem(VK, x.v); }); return; }
      var ch = false; applying = true;
      Object.keys(r.kv).forEach(function (k) { if (localStorage.getItem(k) !== r.kv[k]) { os.call(localStorage, k, r.kv[k]); ch = true; } });
      applying = false; localStorage.setItem(VK, r.v);
      if (ch) { var a = document.activeElement; if (first || !a || !/INPUT|TEXTAREA|SELECT/.test(a.tagName)) location.reload(); else localStorage.removeItem(VK); }
    });
  }

  /* ---------- notifikasi ---------- */
  function u8(s) { s = (s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'); var r = atob(s), a = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) a[i] = r.charCodeAt(i); return a; }
  function pushOn(ask) {
    return Promise.resolve().then(function () {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.Notification) return;
      var pr = Notification.permission === 'default' && ask ? Notification.requestPermission() : Promise.resolve(Notification.permission);
      return pr.then(function (perm) {
        if (perm !== 'granted') return;
        return navigator.serviceWorker.register('/sw.js').then(function () { return navigator.serviceWorker.ready; }).then(function (reg) {
          return api('vapid').then(function (k) {
            return reg.pushManager.getSubscription().then(function (s) { return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8(k.key) }); });
          }).then(function (s) { return api('push', { method: 'POST', body: { sub: s.toJSON() } }); });
        });
      });
    }).catch(function () {});
  }

  /* ---------- tab tambahan ---------- */
  function addTab(id, label, icon, box) {
    var nav = document.querySelector('.nav-tabs'), first = document.querySelector('.tab-content');
    if (!nav || !first || document.getElementById(id)) return;
    nav.appendChild(h('button', { class: 'btn-tab', onclick: "switchTab('" + id + "',event)" }, [h('span', { class: 'ic', text: icon }), h('span', { text: label })]));
    var d = h('div', { id: id, class: 'tab-content' }, box); first.parentNode.appendChild(d);
  }
  function rupiah(n) { return 'Rp ' + (Number(n) || 0).toLocaleString('id-ID'); }

  function buildAkun() {
    var list = h('div'), u = h('input', { placeholder: 'Username' }), p = h('input', { type: 'password', placeholder: 'Password (min. 6)' });
    var r = h('select', {}, ['kasir', 'owner', 'gudang'].map(function (x) { return h('option', { value: x, text: x }); })), er = h('div', { class: 'akerr' });
    function load() { api('users').then(function (x) { list.textContent = '';
      x.users.forEach(function (a) { list.appendChild(h('div', { class: 'akrow' }, [h('span', { text: a.u + ' · ' + a.r }),
        a.r === 'admin' ? h('span') : h('button', { class: 'btn-danger', text: 'Hapus', onclick: function () { if (confirm('Hapus akun ' + a.u + '?')) api('users', { method: 'DELETE', body: { user: a.u } }).then(load); } })])); }); }); }
    addTab('tabAkun', 'Akun', '👤', [h('h4', { text: 'Kelola Akun' }), h('div', { class: 'akf' }, [u, p, r, er,
      h('button', { class: 'btn', text: 'Buat akun', onclick: function () { er.textContent = ''; api('users', { method: 'POST', body: { user: u.value, pass: p.value, role: r.value } }).then(function () { u.value = p.value = ''; load(); }).catch(function (e) { er.textContent = e.message; }); } })]), list]);
    window._akLoadUsers = load;
  }
  function buildPesanan() {
    var list = h('div');
    function load() { api('orders').then(function (x) { list.textContent = '';
      if (!x.orders.length) list.appendChild(h('p', { class: 'hint', text: 'Belum ada pesanan tamu.' }));
      x.orders.slice().reverse().forEach(function (o) {
        var sel = h('select', { onchange: function () { api('order-status', { method: 'POST', body: { nomor: o.nomor, status: sel.value } }).catch(function (e) { alert(e.message); }); } }, STATUS.map(function (s) { var op = h('option', { value: s, text: s }); if (s === o.status) op.selected = true; return op; }));
        list.appendChild(h('div', { class: 'akrow', style: 'display:block' }, [h('b', { text: o.nomor + ' · ' + o.nama }), h('div', { text: o.tanggal + ' · ' + rupiah(o.total) }),
          h('div', { text: '📞 ' + o.hp + ' · 📍 ' + o.alamat }), h('div', { text: o.items.map(function (i) { return i.nama + ' ' + i.q + ' ' + i.s; }).join(', ') }), o.catatan ? h('div', { text: 'Catatan: ' + o.catatan }) : h('span'), sel])); }); }); }
    addTab('tabPesananTamu', 'Pesanan Tamu', '📥', [h('h4', { text: 'Pesanan Tamu' }), h('button', { class: 'btn-cek', text: 'Muat ulang', onclick: load }), list]);
    window._akLoadOrders = load;
  }
  function buildLacak() {
    var no = h('input', { placeholder: 'Nomor pesanan, mis. MH-20261012-101500' }), out = h('div', { style: 'margin-top:10px;font-weight:700' });
    addTab('tabLacak', 'Lacak', '🔎', [h('h4', { text: 'Lacak Pesanan' }), h('div', { class: 'akf' }, [no]),
      h('button', { class: 'btn', text: 'Cek status', onclick: function () { out.textContent = '...'; api('track?no=' + encodeURIComponent(no.value.trim())).then(function (r) { out.textContent = 'Status: ' + r.status; }).catch(function (e) { out.textContent = e.message; }); } }), out]);
  }

  /* ---------- pembatas peran (diulang berkala karena tombol dibuat dinamis) ---------- */
  var sw = null;
  function enforce() {
    document.querySelectorAll('.nav-tabs .btn-tab').forEach(function (b) {
      var m = (b.getAttribute('onclick') || String(b.onclick || '')).match(/tab[A-Z][A-Za-z]+/);
      if (m) b.style.display = ok(m[0]) ? '' : 'none';
    });
    if (window.switchTab && window.switchTab !== sw) { var inner = window.switchTab; sw = function (id) { if (id && !ok(id)) return; var r = inner.apply(this, arguments); if (id === 'tabPesananTamu' && window._akLoadOrders) window._akLoadOrders(); if (id === 'tabAkun' && window._akLoadUsers) window._akLoadUsers(); return r; }; window.switchTab = sw; }
    var act = document.querySelector('.tab-content.active');
    if (!act || !ok(act.id)) { var a = TABS[role], t = a ? a[0] : 'tabNota'; if (window.switchTab) window.switchTab(t); }
    if (typeof window.gtSend === 'function' && !window.gtSend._ak) {
      var g = window.gtSend; window.gtSend = function () { var n = window.gtLoadOrders().length, r = g.apply(this, arguments), a = window.gtLoadOrders();
        if (a.length > n) api('order', { method: 'POST', body: { order: a[a.length - 1] } }).catch(function () {}); return r; }; window.gtSend._ak = 1; }
    ['simpanDanCetakNota', 'cetakUlangNota'].forEach(function (nm) {
      var f = window[nm]; if (typeof f !== 'function' || f._ak) return;
      window[nm] = function () { var r = f.apply(this, arguments); if (me) api('notify', { method: 'POST', body: { title: '🧾 Nota dicetak', body: 'Oleh ' + me.u } }).catch(function () {}); return r; }; window[nm]._ak = 1; });
  }

  /* ---------- mulai ---------- */
  api('status').then(function (s) {
    return (localStorage.getItem(TK) ? api('me').catch(function () { localStorage.removeItem(TK); return null; }) : Promise.resolve(null)).then(function (u) {
      me = u; role = u ? u.r : 'guest'; document.body.classList.add('role-' + role);
      bar(!s.setup); buildLacak();
      if (role === 'admin') buildAkun();
      if (me && role !== 'gudang') buildPesanan();
      enforce(); setInterval(enforce, 800);
      if (!s.setup) { overlay(true); return; }
      if (me) { pull(true).then(function () { setInterval(function () { pull(false).catch(function () {}); }, 15000); }).catch(function () {}); pushOn(false); }
      else api('public').then(function (r) { if (typeof masterBarang !== 'undefined') { masterBarang.length = 0; r.barang.forEach(function (b) { masterBarang.push(b); }); if (window.mhRenderCatalog) try { window.mhRenderCatalog(); } catch (e) {} if (window.gtRender) try { window.gtRender(); } catch (e) {} } }).catch(function () {});
    });
  }).catch(function () {});
})();
