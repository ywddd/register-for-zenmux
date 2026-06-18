#!/usr/bin/env node
/**
 * ZenMux API 抓包工具（带 CapSolver 自动打码）
 *
 * 用途: 手动登录 ZenMux 并创建 API key，本脚本会:
 *   1. 自动解决 Cloudflare Turnstile（通过 CapSolver）
 *   2. 自动填邮箱、获取验证码（Graph API）、输入验证码 → 完成登录
 *   3. 记录所有 API 请求/响应，找出创建 API key 的接口
 *
 * 用法:
 *   node capture_apis.mjs --email xxx@hotmail.com
 *   node capture_apis.mjs --email xxx@hotmail.com --manual   # 登录步骤手动操作（只自动打码）
 *
 * 操作步骤:
 *   1. 启动后自动登录（或 --manual 手动登录）
 *   2. 登录后进入 Settings / API 页面，创建/查看 API key
 *   3. 完成后按 Ctrl+C 退出，结果保存到 captured_apis.json
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { solveTurnstile } from "./capsolver_helper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = path.join(__dirname, "captured_apis.json");
const ACCOUNTS_FILE = process.env.MS_ACCOUNTS_FILE || path.join(__dirname, "zenmux_accounts.json");

const CONFIG = {
  CAPSOLVER_API_KEY: process.env.CAPSOLVER_API_KEY || "",
  HEADLESS: false,
  SLOW_MO: 50,
  CODE_FETCH_TIMEOUT: 150_000,
  CODE_FETCH_INTERVAL: 5_000,
};

const captured = [];
const KEYWORDS = ["key", "api", "token", "secret", "credential"];

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString("zh-CN")}] ${msg}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ============================================================
// 验证码获取（复用 Graph API）
// ============================================================
async function getAccessToken(refresh_token, client_id) {
  try {
    const resp = await fetch("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id, grant_type: "refresh_token", refresh_token }),
    });
    if (resp.ok) { const d = await resp.json(); if (d.access_token) return d.access_token; }
  } catch {}
  return null;
}

async function fetchCode(email, refresh_token, client_id) {
  const startTime = Date.now();
  const monitorStart = new Date(Date.now() - 5_000);
  let token = await getAccessToken(refresh_token, client_id);
  if (!token) { log("无法获取 access_token"); return null; }

  while (Date.now() - startTime < CONFIG.CODE_FETCH_TIMEOUT) {
    for (const folder of ["inbox", "junkemail"]) {
      try {
        const url = `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=10&$orderby=receivedDateTime%20desc`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
        if (resp.status === 401) { token = await getAccessToken(refresh_token, client_id); continue; }
        if (resp.ok) {
          const data = await resp.json();
          for (const msg of data.value || []) {
            if (!msg.subject) continue;
            if (new Date(msg.receivedDateTime) < monitorStart) continue;
            const subject = (msg.subject || "").toLowerCase();
            const from = (msg.from?.emailAddress?.address || "").toLowerCase();
            const preview = (msg.bodyPreview || "").toLowerCase();
            const isZen = from.includes("zenmux") || subject.includes("zenmux") ||
              subject.includes("verification") || subject.includes("verify") ||
              subject.includes("code") || preview.includes("zenmux");
            if (isZen) {
              const m = (msg.bodyPreview || msg.subject || "").match(/\b(\d{6})\b/);
              if (m) return m[1];
              if (msg.body?.content) { const bm = msg.body.content.match(/\b(\d{6})\b/); if (bm) return bm[1]; }
            }
          }
        }
      } catch {}
    }
    await sleep(CONFIG.CODE_FETCH_INTERVAL);
  }
  return null;
}

// ============================================================
// 自动登录
// ============================================================
async function autoLogin(page, account) {
  const { email, refresh_token, client_id } = account;

  // patch turnstile.render 拦截 callback
  await page.addInitScript(() => {
    let tsObj = null;
    const interval = setInterval(() => {
      if (window.turnstile && window.turnstile !== tsObj && window.turnstile.render) {
        tsObj = window.turnstile;
        const orig = tsObj.render;
        tsObj.render = function (c, p) { if (p) window.__tsCallback = p.callback; try { return orig.apply(this, arguments); } catch (e) {} };
        clearInterval(interval);
      }
    }, 20);
    setTimeout(() => clearInterval(interval), 15000);
  });

  log("打开 ZenMux...");
  await page.goto("https://zenmux.ai", { waitUntil: "networkidle", timeout: 60_000 });
  await sleep(3000);

  // Sign In
  for (const sel of ['button:has-text("Sign In")', 'a:has-text("Sign In")']) {
    try { const el = page.locator(sel).first(); if (await el.isVisible({ timeout: 2000 })) { await el.click(); break; } } catch {}
  }
  await sleep(2000);

  // Continue with Email
  try { const b = page.locator('button:has-text("Continue with Email")').first(); if (await b.isVisible({ timeout: 5000 })) await b.click(); } catch {}
  await sleep(2500);

  // 填邮箱
  let emailInput = null;
  for (const sel of ['input[id="email"]', 'input[type="email"]', 'input[placeholder*="email" i]']) {
    try { const els = await page.$$(sel); for (const el of els) { if (await el.isVisible()) { emailInput = el; break; } } if (emailInput) break; } catch {}
  }
  if (!emailInput) throw new Error("找不到邮箱输入框");
  await emailInput.click({ clickCount: 3 });
  await emailInput.fill(email);
  log(`已输入邮箱: ${email}`);
  await sleep(1000);

  // 解决 Turnstile
  log("解决 Turnstile (CapSolver)...");
  let solved = false;
  if (CONFIG.CAPSOLVER_API_KEY) {
    try {
      let sitekey = await page.evaluate(() => {
        const c = document.querySelector('[data-sitekey]'); if (c) return c.getAttribute("data-sitekey");
        const i = document.querySelector('iframe[src*="challenges.cloudflare.com"]'); if (i) { const m = i.src.match(/sitekey=([^&]+)/); if (m) return decodeURIComponent(m[1]); }
        return null;
      });
      if (!sitekey) {
        const reqs = [];
        const h = r => { if (r.url().includes('challenges.cloudflare.com/turnstile')) reqs.push(r.url()); };
        page.on('request', h); await sleep(2000); page.off('request', h);
        for (const u of reqs) { const m = u.match(/\/0x[A-Fa-f0-9]{20,}\//); if (m) { sitekey = m[0].replace(/\//g, ''); break; } }
      }
      if (!sitekey) sitekey = "0x4AAAAAAB3vWB8HhhtIcASj";
      log(`sitekey: ${sitekey.slice(0, 20)}...`);

      const solution = await solveTurnstile({ apiKey: CONFIG.CAPSOLVER_API_KEY, websiteURL: page.url(), websiteKey: sitekey });
      log(`CapSolver token 获取成功`);

      const injected = await page.evaluate((token) => {
        const inputs = document.querySelectorAll('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
        for (const input of inputs) { input.value = token; input.dispatchEvent(new Event("change", { bubbles: true })); input.dispatchEvent(new Event("input", { bubbles: true })); }
        let cb = false; if (typeof window.__tsCallback === "function") { try { window.__tsCallback(token); cb = true; } catch {} }
        return cb;
      }, solution.token);
      solved = true;
      log(injected ? "✓ Turnstile 已解决 (callback)" : "✓ Turnstile 已解决 (注入)");
    } catch (e) { log(`CapSolver 失败: ${e.message}`); }
  } else {
    log("⚠ 未配置 CAPSOLVER_API_KEY，需手动完成 Turnstile");
  }

  // 等待 Send 按钮启用
  if (solved) {
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const enabled = await page.evaluate(() => {
        const s = Array.from(document.querySelectorAll("button")).filter(e => e.offsetParent).find(b => (b.textContent || "").includes("Send"));
        return s ? !s.disabled : false;
      });
      if (enabled) { log("✓ Send 按钮已启用"); break; }
    }
  }

  // 点击发送验证码
  log("发送验证码...");
  let sendBtn = null;
  for (const sel of ['button:has-text("Send Email")', 'button:has-text("Send")']) {
    try { const el = page.locator(sel).first(); if (await el.isVisible({ timeout: 2000 })) { sendBtn = el; break; } } catch {}
  }
  if (sendBtn) {
    if (await sendBtn.isDisabled().catch(() => false)) {
      await page.evaluate(() => { document.querySelectorAll('button[disabled]').forEach(b => { if ((b.textContent || "").toLowerCase().includes("send")) { b.disabled = false; b.removeAttribute("disabled"); } }); });
    }
    await sendBtn.click({ force: true });
  }

  // 获取验证码
  log("等待邮箱验证码...");
  const code = await fetchCode(email, refresh_token, client_id);
  if (!code) throw new Error("获取验证码超时");
  log(`验证码: ${code}`);

  await sleep(2000);
  // OTP 单框 type
  const otpSingle = await page.$('input.otpNativeInput-LCOdN2Gu, input[maxlength="6"]');
  if (otpSingle && await otpSingle.isVisible().catch(() => false)) {
    await otpSingle.click(); await otpSingle.type(code, { delay: 100 });
  } else {
    const otps = await page.$$('input[maxlength="1"]');
    if (otps.length === 6) { for (let i = 0; i < 6; i++) { await otps[i].click(); await otps[i].fill(code[i]); await sleep(100); } }
    else { for (const sel of ['input[placeholder*="code" i]', 'input[type="text"]']) { try { const els = await page.$$(sel); for (const el of els) { if (await el.isVisible().catch(() => false)) { await el.click({ clickCount: 3 }); await el.type(code, { delay: 100 }); break; } } } catch {} } }
  }

  // 等待登录
  log("等待登录完成...");
  let ok = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const url = page.url();
    if (url.includes("/chat") || url.includes("/settings") || (url.includes("zenmux.ai") && !url.includes("/sign") && !url.includes("/login"))) { ok = true; break; }
  }
  log(ok ? "✅ 登录成功" : "⚠ 登录状态不确定，请检查浏览器");
  return ok;
}

// ============================================================
// 主流程
// ============================================================
(async () => {
  // 解析参数
  const args = process.argv.slice(2);
  const emailArg = args.includes("--email") ? args[args.indexOf("--email") + 1] : null;
  const manual = args.includes("--manual");

  if (!emailArg) {
    log("用法: node capture_apis.mjs --email xxx@hotmail.com [--manual]");
    log("  --manual: 只自动打码，登录步骤手动操作");
    process.exit(1);
  }

  // 加载账号
  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf-8"));
  const account = accounts.find(a => a.email.toLowerCase() === emailArg.toLowerCase());
  if (!account) { log(`未找到账号: ${emailArg}`); process.exit(1); }

  log("启动抓包浏览器（有头模式）...");
  const browser = await chromium.launch({ headless: CONFIG.HEADLESS, slowMo: CONFIG.SLOW_MO });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 850 }, locale: "en-US",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // 抓包：监听所有 zenmux API 请求
  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("zenmux.ai")) return;
    if (!url.includes("/api/") && !url.includes("/auth/")) return;
    const entry = { time: new Date().toISOString(), method: req.method(), url, headers: {}, postData: null, response: null };
    const h = req.headers();
    entry.headers = { authorization: h["authorization"] || null, cookie: h["cookie"] ? "[present]" : null, "content-type": h["content-type"] || null };
    try { entry.postData = req.postData() || null; } catch {}
    captured.push(entry);
    log(`#${captured.length} → ${entry.method} ${url.replace("https://zenmux.ai", "")}`);
  });
  page.on("response", async (resp) => {
    const url = resp.url();
    if (!url.includes("zenmux.ai")) return;
    if (!url.includes("/api/") && !url.includes("/auth/")) return;
    const entry = [...captured].reverse().find((e) => e.url === url && !e.response);
    if (!entry) return;
    entry.response = { status: resp.status() };
    try {
      const ct = resp.headers()["content-type"] || "";
      if (ct.includes("json")) {
        const body = await resp.json();
        entry.response.body = body;
        const bs = JSON.stringify(body).toLowerCase();
        if (KEYWORDS.some((k) => bs.includes(k))) {
          log(`#${captured.indexOf(entry) + 1} ← ${resp.status()} [★ 含关键词] ${JSON.stringify(body).slice(0, 200)}`);
        }
      }
    } catch {}
  });

  if (manual) {
    // manual 模式: 只注入 turnstile patch，让用户手动操作
    await page.addInitScript(() => {
      let tsObj = null;
      const interval = setInterval(() => {
        if (window.turnstile && window.turnstile !== tsObj && window.turnstile.render) {
          tsObj = window.turnstile;
          const orig = tsObj.render;
          tsObj.render = function (c, p) { if (p) window.__tsCallback = p.callback; try { return orig.apply(this, arguments); } catch (e) {} };
          clearInterval(interval);
        }
      }, 20);
      setTimeout(() => clearInterval(interval), 15000);
    });
    await page.goto("https://zenmux.ai", { waitUntil: "domcontentloaded" });
    log("已打开页面，请手动操作（Turnstile 会尝试自动解决）...");
  } else {
    // 自动登录
    try {
      await autoLogin(page, account);
    } catch (e) {
      log(`自动登录失败: ${e.message}`);
      log("请手动完成登录，抓包仍在继续...");
    }
  }

  log("");
  log("═══════════════════════════════════════════════════");
  log("  登录完成，现在请操作:");
  log("  1. 进入 Settings / API 页面");
  log("  2. 创建或查看 API key");
  log("  3. 完成后按 Ctrl+C 退出并保存");
  log("═══════════════════════════════════════════════════");
  log("");

  process.on("SIGINT", async () => {
    log(`\n保存 ${captured.length} 条 API 记录...`);
    const byPath = {};
    for (const e of captured) { const p = new URL(e.url).pathname; if (!byPath[p]) byPath[p] = []; byPath[p].push(e); }
    const report = {
      capturedAt: new Date().toISOString(),
      account: account.email,
      totalRequests: captured.length,
      summary: Object.keys(byPath).map(p => ({ path: p, methods: [...new Set(byPath[p].map(e => e.method))], count: byPath[p].length })),
      requests: captured,
    };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
    log(`✓ 已保存: ${OUTPUT_FILE}`);
    log("API 路径汇总:");
    for (const s of report.summary) log(`  ${s.methods.join("/")}  ${s.path}  (${s.count}次)`);

    const keyRelated = captured.filter(e => { const s = (e.url + JSON.stringify(e.response?.body || "")).toLowerCase(); return KEYWORDS.some(k => s.includes(k)); });
    if (keyRelated.length > 0) {
      const keyFile = path.join(__dirname, "captured_apis_keys.json");
      fs.writeFileSync(keyFile, JSON.stringify(keyRelated, null, 2));
      log(`★ 可能含 API key 的请求 ${keyRelated.length} 条 → ${keyFile}`);
    }
    await browser.close();
    process.exit(0);
  });

  log("等待操作... (Ctrl+C 退出并保存)");
  await new Promise(() => {});
})().catch((e) => { log(`错误: ${e.message}`); process.exit(1); });
