/**
 * dashboard.js — Meteor Garden Bot
 * Web monitoring dashboard — port 3000
 *
 * Cara pakai:
 *   node dashboard.js          (standalone)
 *   atau di-import dari index.js
 *
 * Membaca langsung dari:
 *   state.json, lessons.json, lazy-lp-state.json,
 *   strategy-library.json, user-config.json
 * Dan mem-proxy log dari bot via shared log buffer.
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.DASHBOARD_PORT || 3000;

// ─── File paths ──────────────────────────────────────────────────
const FILES = {
    state: path.join(__dirname, "state.json"),
    lessons: path.join(__dirname, "lessons.json"),
    lazyLp: path.join(__dirname, "lazy-lp-state.json"),
    strategy: path.join(__dirname, "strategy-library.json"),
    config: path.join(__dirname, "user-config.json"),
    poolMem: path.join(__dirname, "pool-memory.json"),
    decLog: path.join(__dirname, "decision-log.json"),
};

function readJson(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch { return null; }
}

// ─── In-memory log buffer (last 200 lines) ───────────────────────
const LOG_BUFFER = [];
const MAX_LOG = 200;

export function pushDashboardLog(line) {
    LOG_BUFFER.push({ t: Date.now(), line });
    if (LOG_BUFFER.length > MAX_LOG) LOG_BUFFER.shift();
}

// ─── API handlers ────────────────────────────────────────────────
function apiData() {
    const state = readJson(FILES.state) || {};
    const lessons = readJson(FILES.lessons) || { lessons: [], performance: [] };
    const lazyLp = readJson(FILES.lazyLp) || {};
    const strategy = readJson(FILES.strategy) || {};
    const config = readJson(FILES.config) || {};
    const poolMem = readJson(FILES.poolMem) || {};
    const decLog = readJson(FILES.decLog) || [];

    // Positions dari state
    const positions = Object.entries(state)
        .filter(([k]) => !k.startsWith("_") && state[k]?.pool)
        .map(([addr, p]) => ({ address: addr, ...p }));


    // Performance stats
    const perf = lessons.performance || [];
    const closed = perf.filter(p => p.outcome);
    const wins = closed.filter(p => (p.pnl_pct || 0) > 0).length;
    const losses = closed.filter(p => (p.pnl_pct || 0) <= 0).length;
    const avgPnl = closed.length
        ? (closed.reduce((s, p) => s + (p.pnl_pct || 0), 0) / closed.length).toFixed(2)
        : 0;
    const totalFee = perf.reduce((s, p) => s + (p.fee_earned_usd || 0), 0).toFixed(2);

    // Recent decisions
    const decisions = Array.isArray(decLog) ? decLog.slice(-10).reverse() : [];

    // Pool memories summary
    const pools = Object.entries(poolMem).slice(-10).map(([addr, m]) => ({
        address: addr.slice(0, 8) + "...",
        notes: m.notes?.slice(-1)?.[0]?.note || "",
        deploys: m.deploy_count || 0,
    }));

    return {
        timestamp: new Date().toISOString(),
        dry_run: config.dryRun ?? true,
        macro: {
            zone: lazyLp.zone_trigger || "UNKNOWN",
            lazy_active: lazyLp.active || false,
            mode: lazyLp.mode || null,
        },
        wallet: {
            address: config.walletKey ? "(set)" : "(not set)",
            deploy_amount: config.deployAmountSol || 0,
            max_positions: config.maxPositions || 1,
        },
        positions,
        stats: { wins, losses, avg_pnl_pct: avgPnl, total_fee_usd: totalFee, total_closed: closed.length },
        lessons: (lessons.lessons || []).slice(-10).reverse(),
        decisions,
        strategy: strategy.active || null,
        pools,
        logs: LOG_BUFFER.slice(-50).reverse(),
    };
}

// ─── HTML Dashboard ──────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Meteor Garden — Bot Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;800&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#080c10;
  --surface:#0d1117;
  --surface2:#131a22;
  --border:#1e2d3d;
  --accent:#00d4ff;
  --accent2:#7c3aed;
  --green:#00ff87;
  --red:#ff4757;
  --amber:#ffb347;
  --text:#e2e8f0;
  --muted:#4a5568;
  --font-mono:'Space Mono',monospace;
  --font-display:'Syne',sans-serif;
}
body{background:var(--bg);color:var(--text);font-family:var(--font-mono);font-size:13px;min-height:100vh;overflow-x:hidden}

/* Grid noise texture */
body::before{content:'';position:fixed;inset:0;background-image:radial-gradient(circle at 20% 50%,rgba(0,212,255,0.03) 0%,transparent 50%),radial-gradient(circle at 80% 20%,rgba(124,58,237,0.04) 0%,transparent 50%);pointer-events:none;z-index:0}

header{position:relative;z-index:1;padding:20px 24px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:linear-gradient(180deg,rgba(0,212,255,0.04) 0%,transparent 100%)}
.logo{font-family:var(--font-display);font-weight:800;font-size:20px;letter-spacing:-0.5px}
.logo span{color:var(--accent)}
.logo small{font-family:var(--font-mono);font-size:10px;font-weight:400;color:var(--muted);display:block;letter-spacing:2px;text-transform:uppercase;margin-top:2px}
.header-right{display:flex;align-items:center;gap:12px}
.badge{padding:4px 10px;border-radius:4px;font-size:10px;letter-spacing:1px;text-transform:uppercase;font-weight:700}
.badge.live{background:rgba(255,71,87,0.15);color:var(--red);border:1px solid rgba(255,71,87,0.3)}
.badge.dry{background:rgba(255,179,71,0.15);color:var(--amber);border:1px solid rgba(255,179,71,0.3)}
.last-update{font-size:10px;color:var(--muted)}

main{position:relative;z-index:1;padding:20px 24px;display:grid;grid-template-columns:repeat(12,1fr);gap:16px;max-width:1400px}

.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;transition:border-color 0.2s}
.card:hover{border-color:rgba(0,212,255,0.2)}
.card-title{font-family:var(--font-display);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:var(--muted);margin-bottom:14px;display:flex;align-items:center;gap:8px}
.card-title::before{content:'';width:3px;height:12px;background:var(--accent);border-radius:2px;display:inline-block}

/* Zone card */
.zone-card{grid-column:span 3}
.zone-label{font-family:var(--font-display);font-size:32px;font-weight:800;line-height:1;margin-bottom:4px}
.zone-label.BULL{color:var(--green)}
.zone-label.NEUTRAL{color:var(--accent)}
.zone-label.CAUTION{color:var(--amber)}
.zone-label.FEAR{color:#ff6b35}
.zone-label.DEEP_WINTER{color:#a78bfa}
.zone-label.UNKNOWN{color:var(--muted)}
.zone-sub{font-size:10px;color:var(--muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:12px}
.lazy-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:1px}
.lazy-badge.on{background:rgba(0,255,135,0.1);color:var(--green);border:1px solid rgba(0,255,135,0.2)}
.lazy-badge.off{background:rgba(74,85,104,0.2);color:var(--muted);border:1px solid var(--border)}

/* Stats row */
.stat-card{grid-column:span 2}
.stat-val{font-family:var(--font-display);font-size:28px;font-weight:800;line-height:1;margin-bottom:4px}
.stat-val.green{color:var(--green)}
.stat-val.red{color:var(--red)}
.stat-val.accent{color:var(--accent)}
.stat-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px}

/* Positions */
.pos-card{grid-column:span 6}
.pos-empty{color:var(--muted);font-size:12px;padding:20px 0;text-align:center;border:1px dashed var(--border);border-radius:6px}
.pos-item{padding:10px 12px;background:var(--surface2);border-radius:6px;margin-bottom:8px;border-left:3px solid var(--accent)}
.pos-item:last-child{margin-bottom:0}
.pos-addr{font-size:11px;color:var(--muted);margin-bottom:4px}
.pos-pair{font-family:var(--font-display);font-size:14px;font-weight:600}
.pos-meta{display:flex;gap:16px;margin-top:6px;font-size:11px;color:var(--muted)}
.pos-pnl{font-weight:700}
.pos-pnl.up{color:var(--green)}
.pos-pnl.dn{color:var(--red)}

/* Log */
.log-card{grid-column:span 6}
.log-inner{height:200px;overflow-y:auto;font-size:11px;line-height:1.7}
.log-inner::-webkit-scrollbar{width:4px}
.log-inner::-webkit-scrollbar-track{background:transparent}
.log-inner::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.log-line{padding:2px 0;border-bottom:1px solid rgba(30,45,61,0.5);display:flex;gap:10px}
.log-time{color:var(--muted);flex-shrink:0;font-size:10px}
.log-text{color:var(--text);word-break:break-all}
.log-text.err{color:var(--red)}
.log-text.ok{color:var(--green)}
.log-text.warn{color:var(--amber)}
.log-text.info{color:var(--accent)}

/* Lessons */
.lessons-card{grid-column:span 6}
.lesson-item{padding:8px 10px;border-left:2px solid var(--accent2);margin-bottom:6px;font-size:11px;line-height:1.5;color:#9ab}
.lesson-item:last-child{margin-bottom:0}

/* Decisions */
.dec-card{grid-column:span 6}
.dec-item{padding:8px 10px;background:var(--surface2);border-radius:4px;margin-bottom:6px;font-size:11px}
.dec-item:last-child{margin-bottom:0}
.dec-action{font-weight:700;color:var(--accent);margin-bottom:2px}
.dec-reason{color:var(--muted);line-height:1.4}

/* Pulse dot */
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;animation:pulse 2s infinite}
.dot.green{background:var(--green)}
.dot.red{background:var(--red)}
.dot.amber{background:var(--amber)}

/* Refresh btn */
.refresh-btn{background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.2);color:var(--accent);padding:6px 14px;border-radius:4px;cursor:pointer;font-family:var(--font-mono);font-size:11px;letter-spacing:1px;transition:all 0.2s}
.refresh-btn:hover{background:rgba(0,212,255,0.2)}

/* Scrollbar global */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:var(--surface)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style>
</head>
<body>
<header>
  <div class="logo">
    Meteor<span>Garden</span>
    <small>DLMM LP Bot — Monitoring Dashboard</small>
  </div>
  <div class="header-right">
    <span id="mode-badge" class="badge dry">DRY RUN</span>
    <span class="last-update">Updated: <span id="last-update">—</span></span>
    <button class="refresh-btn" onclick="loadData()">⟳ Refresh</button>
  </div>
</header>

<main>
  <!-- Zone -->
  <div class="card zone-card">
    <div class="card-title">Macro Zone</div>
    <div class="zone-label UNKNOWN" id="zone-label">—</div>
    <div class="zone-sub" id="zone-sub">Loading...</div>
    <div id="lazy-badge" class="lazy-badge off">Lazy LP Off</div>
  </div>

  <!-- Stats -->
  <div class="card stat-card">
    <div class="card-title">Win Rate</div>
    <div class="stat-val accent" id="stat-winrate">—</div>
    <div class="stat-label">Closed trades</div>
  </div>
  <div class="card stat-card">
    <div class="card-title">Avg PnL</div>
    <div class="stat-val" id="stat-avgpnl">—</div>
    <div class="stat-label">Per position</div>
  </div>
  <div class="card stat-card">
    <div class="card-title">Total Fee</div>
    <div class="stat-val green" id="stat-fee">—</div>
    <div class="stat-label">USD earned</div>
  </div>
  <div class="card stat-card">
    <div class="card-title">Positions</div>
    <div class="stat-val accent" id="stat-positions">—</div>
    <div class="stat-label">Open now</div>
  </div>

  <!-- Positions -->
  <div class="card pos-card">
    <div class="card-title">Open Positions</div>
    <div id="positions-list"><div class="pos-empty">No open positions</div></div>
  </div>

  <!-- Log -->
  <div class="card log-card">
    <div class="card-title"><span class="dot green"></span> Live Log</div>
    <div class="log-inner" id="log-list"></div>
  </div>

  <!-- Lessons -->
  <div class="card lessons-card">
    <div class="card-title">Recent Lessons Learned</div>
    <div id="lessons-list"><div class="pos-empty">No lessons yet</div></div>
  </div>

  <!-- Decisions -->
  <div class="card dec-card">
    <div class="card-title">Recent Decisions</div>
    <div id="decisions-list"><div class="pos-empty">No decisions yet</div></div>
  </div>
</main>

<script>
async function loadData() {
  try {
    const res  = await fetch('/api/data');
    const data = await res.json();

    // Mode badge
    const badge = document.getElementById('mode-badge');
    badge.textContent = data.dry_run ? 'DRY RUN' : 'LIVE';
    badge.className   = 'badge ' + (data.dry_run ? 'dry' : 'live');

    // Last update
    document.getElementById('last-update').textContent =
      new Date(data.timestamp).toLocaleTimeString();

    // Macro zone
    const zl = document.getElementById('zone-label');
    zl.textContent  = data.macro.zone;
    zl.className    = 'zone-label ' + data.macro.zone;
    document.getElementById('zone-sub').textContent =
      'Lazy LP Mode: ' + (data.macro.mode || 'Off');
    const lb = document.getElementById('lazy-badge');
    lb.textContent  = data.macro.lazy_active ? '🦥 Lazy LP ' + data.macro.mode : 'Lazy LP Off';
    lb.className    = 'lazy-badge ' + (data.macro.lazy_active ? 'on' : 'off');

    // Stats
    const total = data.stats.wins + data.stats.losses;
    const wr    = total > 0 ? ((data.stats.wins / total) * 100).toFixed(0) + '%' : '—';
    document.getElementById('stat-winrate').textContent  = wr;
    const pnl = document.getElementById('stat-avgpnl');
    pnl.textContent = data.stats.avg_pnl_pct + '%';
    pnl.className   = 'stat-val ' + (data.stats.avg_pnl_pct > 0 ? 'green' : 'red');
    document.getElementById('stat-fee').textContent      = '$' + data.stats.total_fee_usd;
    document.getElementById('stat-positions').textContent = data.positions.length;

    // Positions
    const pl = document.getElementById('positions-list');
    if (!data.positions.length) {
      pl.innerHTML = '<div class="pos-empty">No open positions</div>';
    } else {
      pl.innerHTML = data.positions.map(p => {
        const pnlClass = (p.pnl_pct || 0) >= 0 ? 'up' : 'dn';
        return \`<div class="pos-item">
          <div class="pos-addr">\${p.address?.slice(0,16)}...</div>
          <div class="pos-pair">\${p.pair || p.pool?.slice(0,12) || '—'}</div>
          <div class="pos-meta">
            <span>PnL: <span class="pos-pnl \${pnlClass}">\${p.pnl_pct?.toFixed(2) || '0'}%</span></span>
            <span>Fee: $\${p.fee_earned_usd?.toFixed(2) || '0'}</span>
            <span>\${p.in_range ? '🟢 In range' : '🔴 OOR'}</span>
          </div>
        </div>\`;
      }).join('');
    }

    // Logs
    const ll = document.getElementById('log-list');
    if (!data.logs.length) {
      ll.innerHTML = '<div style="color:var(--muted);padding:8px">No logs yet</div>';
    } else {
      ll.innerHTML = data.logs.map(l => {
        const t    = new Date(l.t).toLocaleTimeString();
        const text = l.line || '';
        let cls    = '';
        if (/error|fail|warn/i.test(text)) cls = 'err';
        else if (/✅|success|deploy|claim/i.test(text)) cls = 'ok';
        else if (/⚠️|caution|fear/i.test(text)) cls = 'warn';
        else if (/macro|integration|jito/i.test(text)) cls = 'info';
        return \`<div class="log-line"><span class="log-time">\${t}</span><span class="log-text \${cls}">\${text.replace(/</g,'&lt;')}</span></div>\`;
      }).join('');
    }

    // Lessons
    const lesList = document.getElementById('lessons-list');
    if (!data.lessons.length) {
      lesList.innerHTML = '<div class="pos-empty">No lessons yet</div>';
    } else {
      lesList.innerHTML = data.lessons.map(l =>
        \`<div class="lesson-item">\${l.rule || l}</div>\`
      ).join('');
    }

    // Decisions
    const decList = document.getElementById('decisions-list');
    if (!data.decisions.length) {
      decList.innerHTML = '<div class="pos-empty">No decisions yet</div>';
    } else {
      decList.innerHTML = data.decisions.map(d =>
        \`<div class="dec-item">
          <div class="dec-action">\${d.action || d.tool || '—'}</div>
          <div class="dec-reason">\${d.reason || d.result || '—'}</div>
        </div>\`
      ).join('');
    }

  } catch(e) {
    console.error('Dashboard fetch error:', e);
  }
}

// Auto-refresh setiap 15 detik
loadData();
setInterval(loadData, 15000);
</script>
</body>
</html>`;

// ─── HTTP Server ──────────────────────────────────────────────────
export function startDashboard() {
    const server = http.createServer((req, res) => {
        if (req.url === "/api/data") {
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify(apiData()));
            return;
        }

        if (req.url === "/" || req.url === "/index.html") {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(HTML);
            return;
        }

        res.writeHead(404);
        res.end("Not found");
    });

    server.listen(PORT, "0.0.0.0", () => {
        console.log(`\n🌐 Dashboard: http://localhost:${PORT}`);
    });

    return server;
}

// Standalone mode
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    startDashboard();
}