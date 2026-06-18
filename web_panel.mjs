#!/usr/bin/env node
/**
 * ZenMux 注册机 - Web 管理面板
 *
 * 零依赖版: 使用 Node 原生 http 模块，前端轮询替代 WebSocket
 */

import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { solveTurnstile, solveRecaptchaV2, solveRecaptchaV3, solveHCaptcha, getBalance } from "./capsolver_helper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

// ============================================================
// 配置
// ============================================================
const CONFIG = {
  PORT: parseInt(process.env.WEB_PORT || "17380"),
  HOST: process.env.WEB_HOST || "127.0.0.1",
  ZENMUX_LOGIN_URL: "https://zenmux.ai/auth/signup",
  HOTMAIL_API_BASE: process.env.HOTMAIL_API_BASE || "http://127.0.0.1:17373",
  HOTMAIL_API_PASSWORD: process.env.HOTMAIL_HELPER_PASSWORD || "",
  MS_ACCOUNTS_FILE: process.env.MS_ACCOUNTS_FILE || path.join(__dirname, "zenmux_accounts.json"),
  ACCOUNTS_DIR: process.env.ACCOUNTS_DIR || path.join(HOME, ".cli-proxy-api"),
  INVITE_CODES: (process.env.ZENMUX_INVITE_CODE || "").split(",").map(s => s.trim()).filter(Boolean),
  CAPSOLVER_API_KEY: process.env.CAPSOLVER_API_KEY || "",
  HEADLESS: process.env.HEADLESS !== "false",
  SLOW_MO: parseInt(process.env.SLOW_MO || "100"),
  TURNSTILE_TIMEOUT: 120_000,
  CODE_SEND_TIMEOUT: 30_000,
  CODE_FETCH_TIMEOUT: 150_000,
  CODE_FETCH_INTERVAL: 5_000,
  // Graph API 单条路最多等多久，超时就换 hotmail_helper（默认 60 秒）
  GRAPH_FETCH_TIMEOUT: parseInt(process.env.GRAPH_FETCH_TIMEOUT || "60000"),
  // hotmail_helper 单条路最多等多久（默认 60s，与 ZenMux Send 按钮重发冷却一致）
  HOTMAIL_FETCH_TIMEOUT: parseInt(process.env.HOTMAIL_FETCH_TIMEOUT || "60000"),
  // 并发注册：同时进行中的账号数（默认 3，上限 20）
  CONCURRENCY: Math.min(20, Math.max(1, parseInt(process.env.CONCURRENCY || "3"))),
  // gpt-load 导入配置（把 ZenMux pay key 自动导入 gpt-load）
  GPTLOAD_BASE: process.env.GPTLOAD_BASE || "http://127.0.0.1:3001",
  GPTLOAD_AUTH_KEY: process.env.GPTLOAD_AUTH_KEY || "",
  // pay key 导入到哪个分组 id（留空则不自动导入）
  GPTLOAD_PAY_GROUP_ID: process.env.GPTLOAD_PAY_GROUP_ID || "",
  // 动态代理（可选）：rotating 代理 URL，格式 http://user:pass@host:port 或 http://host:port
  // 每个浏览器上下文走该代理；留空则不走代理
  PROXY_URL: process.env.PROXY_URL || "",
};

const ENV_FILE = path.join(__dirname, ".env");

// 解析 PROXY_URL 为 Playwright proxy 对象；返回 null 表示不用代理
function parseProxy(url) {
  if (!url) return null;
  try {
    const m = url.match(/^(https?):\/\/(?:([^:@/]+):([^@/]+)@)?([^:/]+)(?::(\d+))?(\/.*)?$/i);
    if (!m) return null;
    const [, scheme, user, pass, host, port] = m;
    const proxy = { server: `${scheme}://${host}:${port || 80}` };
    if (user) { proxy.username = decodeURIComponent(user); proxy.password = decodeURIComponent(pass || ""); }
    return proxy;
  } catch (e) { return null; }
}

// 把配置写回 .env（保留注释/未管理变量，只更新/追加指定键）
function updateEnvFile(updates) {
  let lines = [];
  if (fs.existsSync(ENV_FILE)) lines = fs.readFileSync(ENV_FILE, "utf-8").split(/\r?\n/);
  const keySet = new Set();
  const out = lines.map(line => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && updates.hasOwnProperty(m[1])) {
      keySet.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });
  // 追加未存在的键
  for (const k of Object.keys(updates)) {
    if (!keySet.has(k)) out.push(`${k}=${updates[k]}`);
  }
  fs.writeFileSync(ENV_FILE, out.join("\n") + "\n");
}

const RESULTS_DIR = path.join(__dirname, "zenmux_results");
const SESSIONS_DIR = path.join(__dirname, "zenmux_sessions");
const INVITE_CODES_FILE = path.join(__dirname, "zenmux_invite_codes.json");

// ============================================================
// 日志环形缓冲区（替代 Socket.IO 实时推送）
// ============================================================
const LOG_RING_SIZE = 500;
const logRing = [];
let logSeq = 0;

function log(msg) {
  const ts = new Date().toLocaleTimeString("zh-CN");
  const line = `[${ts}] ${msg}`;
  console.log(line);
  logSeq++;
  logRing.push({ seq: logSeq, ts: Date.now(), text: line });
  if (logRing.length > LOG_RING_SIZE) logRing.shift();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// 账号管理
// ============================================================
function loadAccounts() {
  const accounts = [];
  if (fs.existsSync(CONFIG.MS_ACCOUNTS_FILE)) {
    try {
      const msAccounts = JSON.parse(fs.readFileSync(CONFIG.MS_ACCOUNTS_FILE, "utf-8"));
      for (const acc of msAccounts) {
        if (acc.email && acc.refresh_token && acc.client_id) {
          accounts.push({
            email: acc.email,
            refresh_token: acc.refresh_token,
            client_id: acc.client_id,
            password: acc.password || "",
            type: "microsoft",
            skip: acc.skip === true,
          });
        }
      }
    } catch (e) {}
  }
  return accounts;
}

function saveAccounts(accounts) {
  return withFileLock(CONFIG.MS_ACCOUNTS_FILE, () => {
    const data = accounts.map((a) => ({
      email: a.email,
      password: a.password || "",
      client_id: a.client_id,
      refresh_token: a.refresh_token,
      skip: a.skip === true,
    }));
    fs.writeFileSync(CONFIG.MS_ACCOUNTS_FILE, JSON.stringify(data, null, 2));
  });
}

function loadResults() {
  const summaryPath = path.join(RESULTS_DIR, "summary.jsonl");
  if (!fs.existsSync(summaryPath)) return [];
  const results = [];
  const lines = fs.readFileSync(summaryPath, "utf-8").split("\n");
  for (const line of lines) {
    if (line.trim()) {
      try { results.push(JSON.parse(line)); } catch (e) {}
    }
  }
  return results;
}

// ============================================================
// 邀请码管理（自动提取 + 持久化）
// ============================================================

// 从文件加载已保存的邀请码
function loadSavedInviteCodes() {
  if (!fs.existsSync(INVITE_CODES_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(INVITE_CODES_FILE, "utf-8"));
    return data.filter(d => d.inviteCode).map(d => d.inviteCode);
  } catch (e) { return []; }
}

// 获取所有可用邀请码（.env 配置 + 自动提取的）
function getAllInviteCodes() {
  const envCodes = CONFIG.INVITE_CODES;
  const savedCodes = loadSavedInviteCodes();
  const all = [...new Set([...envCodes, ...savedCodes])];
  return all;
}

// 保存新提取的邀请码
function saveInviteCode(email, inviteCode) {
  return withFileLock(INVITE_CODES_FILE, () => {
    let data = [];
    if (fs.existsSync(INVITE_CODES_FILE)) {
      try { data = JSON.parse(fs.readFileSync(INVITE_CODES_FILE, "utf-8")); } catch (e) {}
    }
    const exists = data.find(d => d.email === email || d.inviteCode === inviteCode);
    if (exists) return;
    data.push({ email, inviteCode, error: null });
    fs.writeFileSync(INVITE_CODES_FILE, JSON.stringify(data, null, 2));
    log(`✓ 邀请码已保存: ${email} → ${inviteCode}`);
  });
}

// 通过浏览器提取已登录账号的邀请码
async function extractInviteCode(page, email, taskId) {
  taskLog(taskId, `提取邀请码: ${email}`);
  try {
    // 方法1: 通过 API 获取
    const cookies = await page.context().cookies("https://zenmux.ai");
    const sessionId = cookies.find(c => c.name === "sessionId");
    if (sessionId) {
      try {
        const resp = await page.evaluate(async () => {
          const r = await fetch("/api/referral/info", {
            headers: { "Accept": "application/json" },
            credentials: "include",
          });
          if (r.ok) return await r.json();
          return null;
        });
        // 实际返回结构: {success, data:{inviteCode}}；兼容直接挂在根上的情况
        const code = resp?.data?.inviteCode || resp?.inviteCode;
        if (code) {
          taskLog(taskId, `✓ API 获取邀请码: ${code}`);
          saveInviteCode(email, code);
          return code;
        }
      } catch (e) {
        taskLog(taskId, `API 获取邀请码失败: ${e.message}`);
      }
    }

    // 方法2: 导航到 referral 页面提取（只接受明确的"邀请码"语境，避免误抓页面里其它 6 位大写串如 "TOKENS"）
    await page.goto("https://zenmux.ai/settings/referral", { waitUntil: "networkidle", timeout: 30_000 });
    await sleep(2000);

    const code = await page.evaluate(() => {
      // 只从明确标注为邀请码的输入框/可复制元素取
      const inputs = Array.from(document.querySelectorAll('input, [data-copy], code'));
      for (const el of inputs) {
        const v = (el.value || el.textContent || "").trim();
        if (/^[A-Z0-9]{6}$/.test(v)) return v;
      }
      // 从复制链接里提取（最可靠：邀请链接含 /invite/CODE）
      const links = Array.from(document.querySelectorAll('a[href*="invite/"], input[value*="invite/"]'));
      for (const link of links) {
        const href = link.href || link.value || "";
        const m = href.match(/invite\/([A-Z0-9]{6})(?:[/?#]|$)/);
        if (m) return m[1];
      }
      return null;
    });

    if (code) {
      taskLog(taskId, `✓ 页面提取邀请码: ${code}`);
      saveInviteCode(email, code);
      return code;
    }

    // 方法3: 通过 invite 页面提取
    await page.goto("https://zenmux.ai/invite", { waitUntil: "networkidle", timeout: 30_000 });
    await sleep(2000);

    const code2 = await page.evaluate(() => {
      // 只认明确语境的邀请码，避免抓到 "TOKENS"/"SETTINGS" 等页面文字
      const inputs = Array.from(document.querySelectorAll('input, code, [data-copy]'));
      for (const el of inputs) {
        const v = (el.value || el.textContent || "").trim();
        if (/^[A-Z0-9]{6}$/.test(v)) return v;
      }
      const links = Array.from(document.querySelectorAll('a[href*="invite/"], input[value*="invite/"]'));
      for (const link of links) {
        const href = link.href || link.value || "";
        const m = href.match(/invite\/([A-Z0-9]{6})(?:[/?#]|$)/);
        if (m) return m[1];
      }
      return null;
    });

    if (code2) {
      taskLog(taskId, `✓ 页面提取邀请码: ${code2}`);
      saveInviteCode(email, code2);
      return code2;
    }

    taskLog(taskId, `⚠ 未能提取到 ${email} 的邀请码`);
    return null;
  } catch (e) {
    taskLog(taskId, `提取邀请码出错: ${e.message}`);
    return null;
  }
}

// ============================================================
// 平台 API Key 管理
//   - pay:       按量付费 key   POST /api/api_key/create       {name, tags:[]}  → sk-ai-v1-...
//   - platform:  平台管理 key   POST /api/management_key/create {name}          → sk-mg-v1-...
// ============================================================
const API_KEYS_FILE = path.join(__dirname, "zenmux_api_keys.json");

// 保存已创建的 API key
function saveApiKey(email, keyInfo) {
  return withFileLock(API_KEYS_FILE, () => {
    let data = [];
    if (fs.existsSync(API_KEYS_FILE)) {
      try { data = JSON.parse(fs.readFileSync(API_KEYS_FILE, "utf-8")); } catch (e) {}
    }
    // 同邮箱同 key id 去重
    data = data.filter(d => !(d.email === email && d.id === keyInfo.id));
    data.push({ email, ...keyInfo, savedAt: new Date().toISOString() });
    fs.writeFileSync(API_KEYS_FILE, JSON.stringify(data, null, 2));
  });
}

// 读取已保存的 API keys
function loadApiKeys() {
  if (!fs.existsSync(API_KEYS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(API_KEYS_FILE, "utf-8")); } catch (e) { return []; }
}

// 通过浏览器 session 查询/创建 API key
// type: "pay" (按量付费 sk-ai-v1) 或 "platform" (平台管理 sk-mg-v1)
async function ensureApiKey(page, email, taskId, type = "pay") {
  const isPlatform = type === "platform";
  const typeName = isPlatform ? "Platform API (平台管理 sk-mg-v1)" : "Pay API (按量付费 sk-ai-v1)";
  const listPath = isPlatform ? "/api/management_key/list" : "/api/api_key/list?type=Managed";
  const createPath = isPlatform ? "/api/management_key/create" : "/api/api_key/create";
  const autoPrefix = isPlatform ? "Platform-Auto-" : "Auto-";

  taskLog(taskId, `检查/创建 ${typeName}: ${email}`);

  try {
    // 1. 先查询现有 key 列表
    const listResp = await page.evaluate(async (path) => {
      const r = await fetch(path, {
        headers: { "Accept": "application/json" },
        credentials: "include",
      });
      // 返回状态码供上层判断 session 是否已失效
      if (r.ok) return { ok: true, data: await r.json() };
      return { ok: false, status: r.status };
    }, listPath);

    // session 失效（401/403）→ 通知调用方需要重新登录
    if (!listResp.ok && (listResp.status === 401 || listResp.status === 403)) {
      taskLog(taskId, `⚠ ${typeName} 列表接口返回 ${listResp.status}，session 可能已失效，需重新登录`);
      return { __needRelogin: true };
    }

    const existingKeys = listResp.data?.data || [];
    taskLog(taskId, `现有 ${typeName} key 数量: ${existingKeys.length}`);

    // 2. 检查是否已有自动创建的 key（按名称前缀匹配）
    const existing = existingKeys.find(k => (k.name || "").startsWith(autoPrefix) && k.enabled !== false);

    if (existing) {
      taskLog(taskId, `✓ 已存在 ${typeName} key: ${existing.name} (${existing.token.slice(0, 20)}...)`);
      saveApiKey(email, {
        id: existing.id, name: existing.name, token: existing.token,
        type: existing.type, keyType: type, enabled: existing.enabled !== false,
      });
      return existing;
    }

    // 3. 创建新 key
    const keyName = `${autoPrefix}${email.split("@")[0]}`;
    taskLog(taskId, `创建新 ${typeName} key: ${keyName}`);

    // 两类 create 接口都需要 CSRF 头（从 ctoken cookie 取）；platform 类连 list 也需要
    const createResp = await page.evaluate(async ({ path, name, withTags }) => {
      const body = withTags ? { name, tags: [] } : { name };
      const headers = { "Content-Type": "application/json", "Accept": "application/json" };
      const m = document.cookie.match(/(?:^|;\s*)ctoken=([^;]+)/);
      if (m) headers["X-CSRF-Token"] = m[1];
      const r = await fetch(path, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (r.ok) return { ok: true, data: await r.json() };
      return { ok: false, status: r.status, error: `HTTP ${r.status}`, body: await r.text().catch(() => "") };
    }, { path: createPath, name: keyName, withTags: !isPlatform });

    // 创建接口也 401/403 → session 失效，需重新登录
    if (!createResp.ok && (createResp.status === 401 || createResp.status === 403)) {
      taskLog(taskId, `⚠ ${typeName} 创建接口返回 ${createResp.status}，session 可能已失效，需重新登录`);
      return { __needRelogin: true };
    }

    if (createResp.ok && createResp.data?.success && createResp.data.data) {
      const newKey = createResp.data.data;
      taskLog(taskId, `✓ ${typeName} key 创建成功: ${newKey.token.slice(0, 20)}...`);
      saveApiKey(email, {
        id: newKey.id, name: newKey.name, token: newKey.token,
        type: newKey.type, keyType: type, enabled: true,
      });
      // pay key 创建成功后，若配置了 gpt-load 分组，自动导入
      if (type === "pay") {
        await autoImportPayKeyToGptLoad(email, newKey.token, taskId);
      }
      return newKey;
    } else {
      taskLog(taskId, `❌ 创建 ${typeName} key 失败: ${JSON.stringify(createResp.ok ? createResp.data : createResp)}`);
      return null;
    }
  } catch (e) {
    taskLog(taskId, `API key 操作出错: ${e.message}`);
    return null;
  }
}

// ============================================================
// gpt-load 导入：把 ZenMux pay key (sk-ai-v1) 自动导入 gpt-load 分组
// ============================================================

// 从 gpt-load 获取分组列表
async function gptLoadListGroups() {
  if (!CONFIG.GPTLOAD_AUTH_KEY) return { ok: false, error: "未配置 GPTLOAD_AUTH_KEY" };
  try {
    const resp = await fetch(`${CONFIG.GPTLOAD_BASE}/api/groups`, {
      headers: { Authorization: `Bearer ${CONFIG.GPTLOAD_AUTH_KEY}` },
    });
    const data = await resp.json();
    if (data.code === 0 || resp.ok) return { ok: true, groups: data.data || [] };
    return { ok: false, error: data.message || `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 把一组 key 文本导入 gpt-load 指定分组
// 返回 { ok, added, ignored, total }
async function gptLoadImportKeys(groupId, keysText) {
  if (!CONFIG.GPTLOAD_AUTH_KEY) return { ok: false, error: "未配置 GPTLOAD_AUTH_KEY" };
  if (!groupId) return { ok: false, error: "未指定分组" };
  try {
    const resp = await fetch(`${CONFIG.GPTLOAD_BASE}/api/keys/add-multiple`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.GPTLOAD_AUTH_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ group_id: parseInt(groupId, 10), keys_text: keysText }),
    });
    const data = await resp.json();
    if (data.code === 0 || resp.ok) {
      return {
        ok: true,
        added: data.data?.added_count ?? 0,
        ignored: data.data?.ignored_count ?? 0,
        total: data.data?.total_in_group ?? 0,
      };
    }
    return { ok: false, error: data.message || `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 创建 pay key 成功后自动导入 gpt-load（若配置了分组）
async function autoImportPayKeyToGptLoad(email, token, taskId) {
  const groupId = CONFIG.GPTLOAD_PAY_GROUP_ID;
  if (!groupId || !CONFIG.GPTLOAD_AUTH_KEY) {
    return; // 未配置则跳过，静默
  }
  taskLog(taskId, `自动导入 gpt-load (分组 ${groupId}): ${email} pay key...`);
  const r = await gptLoadImportKeys(groupId, token);
  if (r.ok) {
    taskLog(taskId, `✓ gpt-load 导入完成: 新增 ${r.added} 个 (重复忽略 ${r.ignored}，分组共 ${r.total})`);
  } else {
    taskLog(taskId, `❌ gpt-load 导入失败: ${r.error}`);
  }
}

function loadSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];

  // 从账号文件获取邮箱列表，用于匹配 session 文件
  const accounts = loadAccounts();
  const emailList = accounts.map(a => a.email);

  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    // 文件名格式: user_hotmail_com.json (邮箱中的 @ 和 . 都被替换为 _)
    const baseName = f.replace(".json", "");
    const filepath = path.join(SESSIONS_DIR, f);

    // 从账号列表中精确匹配邮箱
    // 将每个邮箱转换为文件名格式进行比较
    const matchedEmail = emailList.find(e => {
      const normalized = e.replace(/[@.]/g, "_");
      return normalized === baseName;
    });

    // 如果没匹配到，使用文件名还原（可能不准确）
    const email = matchedEmail || baseName.replace(/_/g, ".");

    try {
      const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));
      const sessionCookie = data.cookies?.find((c) => c.name === "sessionId");
      return {
        email,
        file: f,
        sessionId: sessionCookie?.value || null,
        cookieCount: data.cookies?.length || 0,
        modified: fs.statSync(filepath).mtime.toISOString(),
      };
    } catch (e) {
      return { email, file: f, sessionId: null, cookieCount: 0, error: e.message };
    }
  });
}

// ============================================================
// 注册核心逻辑
// ============================================================
let registering = false;        // 是否有批量注册任务在跑
let stopRequested = false;       // 是否请求停止
let currentTaskId = null;
const registeringAccounts = new Set(); // 正在注册中的账号邮箱
const taskLogs = new Map(); // taskId -> string[]

// ---- 文件写入互斥锁（并发时防止 JSON 读-改-写竞争损坏文件）----
const fileLocks = new Map(); // filePath -> Promise chain
function withFileLock(filePath, fn) {
  const prev = fileLocks.get(filePath) || Promise.resolve();
  const next = prev.then(fn, fn);
  fileLocks.set(filePath, next.catch(() => {}));
  return next;
}

// ---- 并发信号量（限制同时进行的注册数）----
class Semaphore {
  constructor(max) { this.max = max; this.active = 0; this.queue = []; }
  async acquire() {
    if (this.active < this.max) { this.active++; return; }
    await new Promise(resolve => this.queue.push(resolve));
    this.active++;
  }
  release() {
    this.active--;
    if (this.queue.length) this.queue.shift()();
  }
}
const regSemaphore = new Semaphore(CONFIG.CONCURRENCY);

function taskLog(taskId, msg) {
  log(msg);
  if (taskId) {
    if (!taskLogs.has(taskId)) taskLogs.set(taskId, []);
    taskLogs.get(taskId).push(msg);
  }
}

async function getMicrosoftAccessToken(refresh_token, client_id) {
  const tokenUrl = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
  try {
    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id, grant_type: "refresh_token", refresh_token }),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.access_token) return data.access_token;
    }
  } catch (e) {}
  return null;
}

async function fetchVerificationCodeFromGraph(email, refresh_token, client_id, taskId, codeSendTime = 0) {
  const startTime = Date.now();
  taskLog(taskId, `开始监听邮箱 ${email} 的验证码 (Graph API)...`);

  let accessToken = await getMicrosoftAccessToken(refresh_token, client_id);
  if (!accessToken) {
    taskLog(taskId, "无法获取 access_token");
    return null;
  }

  // 只接受"发送验证码之后"到达的邮件（避免读到旧验证码）。
  // 容错：邮件 receivedDateTime 可能略早于本地点击时刻（投递延迟/时钟偏差），给 30s 前置窗口。
  const monitorStartTime = codeSendTime
    ? new Date(codeSendTime - 30_000)
    : new Date(Date.now() - 60_000);

  // Graph 单条路最多跑 GRAPH_FETCH_TIMEOUT，超时就返回 null 让上层换 hotmail_helper
  const graphDeadline = startTime + CONFIG.GRAPH_FETCH_TIMEOUT;

  while (Date.now() < graphDeadline) {
    for (const folder of ["inbox", "junkemail"]) {
      try {
        const url = `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=10&$orderby=receivedDateTime%20desc`;
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        });
        if (resp.status === 401) {
          accessToken = await getMicrosoftAccessToken(refresh_token, client_id);
          continue;
        }
        // 限流：Graph 返回 429 时，按 Retry-After 等待，不要继续猛打
        if (resp.status === 429) {
          const retryAfter = parseInt(resp.headers.get("retry-after") || "3", 10);
          taskLog(taskId, `Graph 限流(429)，等待 ${retryAfter}s 再试...`);
          await sleep(retryAfter * 1000);
          continue;
        }
        if (!resp.ok) {
          taskLog(taskId, `Graph 读 ${folder} 失败: HTTP ${resp.status}`);
          continue;
        }
        {
          const data = await resp.json();
          for (const msg of data.value || []) {
            if (!msg.subject) continue;
            const receivedTime = new Date(msg.receivedDateTime);
            if (receivedTime < monitorStartTime) continue;

            const subject = (msg.subject || "").toLowerCase();
            const fromEmail = msg.from?.emailAddress?.address?.toLowerCase() || "";
            const preview = (msg.bodyPreview || "").toLowerCase();

            const isZenMux =
              fromEmail.includes("zenmux") ||
              subject.includes("zenmux") ||
              subject.includes("verification") ||
              subject.includes("verify") ||
              subject.includes("code") ||
              preview.includes("zenmux") ||
              (fromEmail.includes("noreply") && (subject.includes("code") || subject.includes("verify")));

            if (isZenMux) {
              // 优先从主题里提取（ZenMux 主题就含验证码: "Your ZenMux verification code: 599032"）
              const subjectMatch = (msg.subject || "").match(/\b(\d{6})\b/);
              if (subjectMatch) {
                taskLog(taskId, `找到验证码: ${subjectMatch[1]} (主题: ${msg.subject})`);
                return subjectMatch[1];
              }
              const content = msg.bodyPreview || msg.subject || "";
              const codeMatch = content.match(/\b(\d{6})\b/);
              if (codeMatch) {
                taskLog(taskId, `找到验证码: ${codeMatch[1]} (主题: ${msg.subject})`);
                return codeMatch[1];
              }
              if (msg.body?.content) {
                const bodyMatch = msg.body.content.match(/\b(\d{6})\b/);
                if (bodyMatch) {
                  taskLog(taskId, `从邮件正文找到验证码: ${bodyMatch[1]}`);
                  return bodyMatch[1];
                }
              }
            }
          }
        }
      } catch (e) {
        taskLog(taskId, `Graph 读 ${folder} 异常: ${e.message}`);
      }
      // 每个文件夹调用之间间隔 1 秒，避免连续猛打触发限流
      await sleep(1000);
    }
    await sleep(CONFIG.CODE_FETCH_INTERVAL);
  }

  taskLog(taskId, `Graph API 超 ${Math.round(CONFIG.GRAPH_FETCH_TIMEOUT / 1000)}s 未取到，换 hotmail_helper`);
  return null;
}

async function fetchVerificationCode(email, refresh_token, client_id, taskId, codeSendTime = 0, waitMs = 0) {
  const startTime = Date.now();
  // 单轮等待时长：默认 HOTMAIL_FETCH_TIMEOUT；上层可按轮次传入（第1轮65s、第2轮15s）
  const timeout = waitMs > 0 ? waitMs : CONFIG.HOTMAIL_FETCH_TIMEOUT;
  taskLog(taskId, `开始监听邮箱 ${email} 的验证码 (hotmail_helper，本轮等 ${Math.round(timeout / 1000)}s)...`);

  // 只接受发送验证码之后到达的邮件（容错 30s 前置窗口）
  const monitorStartTime = codeSendTime ? (codeSendTime - 30_000) : (Date.now() - 60_000);

  const helperDeadline = startTime + timeout;

  while (Date.now() < helperDeadline) {
    // 检查收件箱 + 垃圾邮件
    for (const mailbox of ["INBOX", "Junk"]) {
      try {
        const body = { email, refresh_token, client_id, mailbox, top: 5 };
        if (CONFIG.HOTMAIL_API_PASSWORD) body.password = CONFIG.HOTMAIL_API_PASSWORD;
        const resp = await fetch(`${CONFIG.HOTMAIL_API_BASE}/api/mail-new`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (resp.ok) {
          const data = await resp.json();
          const messages = Array.isArray(data) ? data : [data];
          for (const msg of messages) {
            if (!msg || !msg.subject) continue;
            // 时间过滤：只认发送验证码之后到达的邮件，避免旧码
            const msgTime = msg.receivedDateTime || msg.date;
            if (msgTime) {
              const t = new Date(msgTime).getTime();
              if (!isNaN(t) && t < monitorStartTime) continue;
            }
            const subject = (msg.subject || "").toLowerCase();
            const from = (msg.from_email || msg.send || "").toLowerCase();
            const text = (msg.text || msg.bodyPreview || "").toLowerCase();
            const html = (msg.html || "").toLowerCase();
            const isZenMux = from.includes("zenmux") || subject.includes("zenmux") ||
              subject.includes("verification") || subject.includes("verify") || subject.includes("code") ||
              text.includes("zenmux") || html.includes("zenmux");
            if (isZenMux) {
              // 优先从主题提取（ZenMux 主题含验证码）
              const subjectMatch = (msg.subject || "").match(/\b(\d{6})\b/);
              if (subjectMatch) {
                taskLog(taskId, `找到验证码: ${subjectMatch[1]} (主题: ${msg.subject})${mailbox === "Junk" ? " [垃圾邮件]" : ""}`);
                return subjectMatch[1];
              }
              const content = msg.text || msg.bodyPreview || msg.html || "";
              const codeMatch = content.match(/\b(\d{6})\b/);
              if (codeMatch) {
                taskLog(taskId, `找到验证码: ${codeMatch[1]}${mailbox === "Junk" ? " [垃圾邮件]" : ""}`);
                return codeMatch[1];
              }
            }
          }
        }
      } catch (e) {}
    }
    await sleep(CONFIG.CODE_FETCH_INTERVAL);
  }

  taskLog(taskId, `hotmail_helper 超 ${Math.round(CONFIG.HOTMAIL_FETCH_TIMEOUT / 1000)}s 未取到新验证码`);
  return null;
}

// 点击二次验证的提交/确认按钮（验证码页通用，不依赖验证码类型）
async function clickSecondarySubmit(page, taskId) {
  try {
    const submitClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button")).filter(e => e.offsetParent && !e.disabled);
      const submit = btns.find(b => {
        const t = (b.textContent || "").toLowerCase();
        return t.includes("verify") || t.includes("continue") || t.includes("submit") || t.includes("sign in") || t.includes("confirm") || t.includes("登录") || t.includes("验证") || t.includes("确认");
      });
      if (submit) { submit.click(); return true; }
      return false;
    });
    if (submitClicked) taskLog(taskId, "已点击二次验证提交按钮");
    return submitClicked;
  } catch (e) {
    return false;
  }
}

// 通用二次验证打码：按类型调对应 CapSolver 求解器，并把 token 注入页面
// probe = { type: "turnstile"|"recaptcha"|"recaptcha_v3"|"hcaptcha", sitekey, action }
async function solveSecondaryCaptcha(page, taskId, probe, sitekey) {
  const type = probe.type || "turnstile";
  if (!CONFIG.CAPSOLVER_API_KEY) {
    taskLog(taskId, "⚠ 未配置 CAPSOLVER_API_KEY，无法打码");
    return false;
  }

  if (type === "turnstile") {
    taskLog(taskId, `二次 Turnstile sitekey: ${(sitekey || "").slice(0, 20)}...`);
    const solution = await solveTurnstile({
      apiKey: CONFIG.CAPSOLVER_API_KEY, websiteURL: page.url(), websiteKey: sitekey,
    });
    taskLog(taskId, `二次 Turnstile token: ${solution.token.slice(0, 30)}...`);
    const injected = await page.evaluate((token) => {
      const inputs = document.querySelectorAll('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
      for (const input of inputs) {
        input.value = token;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      let cb = false;
      if (typeof window.__tsCallback === "function") { try { window.__tsCallback(token); cb = true; } catch (e) {} }
      return cb;
    }, solution.token);
    taskLog(taskId, injected ? "✓ 二次 Turnstile 已解决 (callback)" : "✓ 二次 Turnstile 已解决 (注入)");
    return true;
  }

  if (type === "recaptcha" || type === "recaptcha_v3") {
    taskLog(taskId, `二次 reCAPTCHA${type === "recaptcha_v3" ? " v3" : " v2"} sitekey: ${(sitekey || "").slice(0, 20)}...`);
    const opts = { apiKey: CONFIG.CAPSOLVER_API_KEY, websiteURL: page.url(), websiteKey: sitekey };
    let token;
    if (type === "recaptcha_v3") {
      token = (await solveRecaptchaV3({ ...opts, pageAction: probe.action || "verify" })).token;
    } else {
      token = (await solveRecaptchaV2(opts)).token;
    }
    taskLog(taskId, `二次 reCAPTCHA token: ${token.slice(0, 30)}...`);
    // 注入 g-recaptcha-response，并尽可能触发页面注册的 callback
    const cbCalled = await page.evaluate((t) => {
      // 设置/创建 token textarea
      let ta = document.getElementById("g-recaptcha-response");
      if (!ta) {
        ta = document.createElement("textarea");
        ta.id = "g-recaptcha-response";
        ta.name = "g-recaptcha-response";
        ta.style.display = "none";
        document.body.appendChild(ta);
      }
      ta.value = t;
      // 尝试从 grecaptcha 内部找 callback 并调用（v2 常见）
      try {
        const cfg = window.___grecaptcha_cfg;
        if (cfg && cfg.clients) {
          for (const cid in cfg.clients) {
            const walk = (obj, depth) => {
              if (!obj || depth > 5) return false;
              for (const k in obj) {
                const v = obj[k];
                if (typeof v === "function") {
                  // 形如 callback 的函数名
                  if (/callback/i.test(k)) { try { v(t); return true; } catch (e) {} }
                } else if (v && typeof v === "object") {
                  if (walk(v, depth + 1)) return true;
                }
              }
              return false;
            };
            if (walk(cfg.clients[cid], 0)) return true;
          }
        }
      } catch (e) {}
      return false;
    }, token);
    taskLog(taskId, cbCalled ? "✓ 二次 reCAPTCHA 已解决 (callback)" : "✓ 二次 reCAPTCHA token 已注入");
    return true;
  }

  if (type === "hcaptcha") {
    taskLog(taskId, `二次 hCaptcha sitekey: ${(sitekey || "").slice(0, 20)}...`);
    const solution = await solveHCaptcha({
      apiKey: CONFIG.CAPSOLVER_API_KEY, websiteURL: page.url(), websiteKey: sitekey,
    });
    taskLog(taskId, `二次 hCaptcha token: ${solution.token.slice(0, 30)}...`);
    await page.evaluate((t) => {
      let ta = document.querySelector('textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]');
      if (!ta) {
        ta = document.querySelector('textarea[name="g-recaptcha-response"]') || document.createElement("textarea");
        ta.name = "h-captcha-response";
        ta.style.display = "none";
        if (!ta.parentElement) document.body.appendChild(ta);
      }
      ta.value = t;
    }, solution.token);
    taskLog(taskId, "✓ 二次 hCaptcha token 已注入");
    return true;
  }

  taskLog(taskId, `⚠ 未知验证类型 ${type}，无法打码`);
  return false;
}

// 调试截图：注册失败时把页面状态存下来，便于排查"验证码对却登录失败"
async function debugScreenshot(page, email, tag, taskId) {
  try {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const safe = email.replace(/[^a-zA-Z0-9@._-]/g, "_");
    const file = path.join(RESULTS_DIR, `debug_${tag}_${safe}_${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    taskLog(taskId, `📷 已截图: ${path.basename(file)} (URL: ${page.url()})`);
    // 同时抓页面可见错误提示文字
    const errText = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[class*="error" i], [class*="Error"], [role="alert"]'));
      const texts = els.map(e => (e.textContent || "").trim()).filter(t => t && t.length < 200);
      return texts.slice(0, 3);
    }).catch(() => []);
    if (errText && errText.length) taskLog(taskId, `页面错误提示: ${JSON.stringify(errText)}`);
  } catch (e) {
    // 截图失败不影响主流程
  }
}

async function registerAccount(account, taskId) {
  const { email, refresh_token, client_id } = account;

  // 标记为跳过的账号直接跳过
  if (account.skip === true) {
    taskLog(taskId, `⚠ ${email} 已标记跳过，不注册`);
    return { success: false, email, sessionId: null, error: "已跳过", skipped: true };
  }

  // 保险：已注册的账号直接跳过，不再打码/启动浏览器
  const existingSessions = loadSessions();
  const alreadyHasSession = existingSessions.find((s) => s.email.toLowerCase() === email.toLowerCase());
  if (alreadyHasSession) {
    taskLog(taskId, `⚠ ${email} 已注册过（已有 session），跳过，不重复打码`);
    return { success: false, email, sessionId: alreadyHasSession.sessionId, error: "已注册过，跳过", skipped: true };
  }

  // 标记账号为注册中
  registeringAccounts.add(email.toLowerCase());

  const result = { success: false, email, sessionId: null, error: null };
  let browser = null, context = null;
  const startedAt = Date.now();

  try {
    taskLog(taskId, `开始注册: ${email}`);
    const proxy = parseProxy(CONFIG.PROXY_URL);
    if (proxy) taskLog(taskId, `使用代理: ${proxy.server}${proxy.username ? " (带鉴权)" : ""}`);
    const launchOpts = { headless: CONFIG.HEADLESS, slowMo: CONFIG.SLOW_MO };
    if (proxy) launchOpts.proxy = proxy;
    browser = await chromium.launch(launchOpts);
    // 启动后简单验证代理是否生效：若 newContext 失败多半是代理连不上
    try {
      context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
      });
    } catch (e) {
      if (proxy) {
        taskLog(taskId, `⚠ 代理连接失败: ${e.message}，跳过该账号`);
        result.error = `代理连接失败: ${e.message}`;
        return result;
      }
      throw e;
    }
    const page = await context.newPage();

    // ---- 早期 patch turnstile.render，拦截 callback ----
    await page.addInitScript(() => {
      let tsObj = null;
      const interval = setInterval(() => {
        if (window.turnstile && window.turnstile !== tsObj && window.turnstile.render) {
          tsObj = window.turnstile;
          const origRender = tsObj.render;
          tsObj.render = function (container, params) {
            if (params) { window.__tsCallback = params.callback; }
            try { return origRender.apply(this, arguments); } catch (e) {}
          };
          clearInterval(interval);
        }
      }, 20);
      setTimeout(() => clearInterval(interval), 15000);
    });

    // 监听验证码发送 API 响应
    let codeSendResult = null;
    page.on("response", async (response) => {
      if (response.url().includes("api/login/email/code/send")) {
        try { codeSendResult = await response.json(); } catch (e) {}
      }
    });

    // ---- 1. 打开页面（优先邀请链接） ----
    const allCodes = getAllInviteCodes();
    const inviteCode = allCodes.length > 0
      ? allCodes[Math.floor(Math.random() * allCodes.length)]
      : "";

    if (inviteCode) {
      taskLog(taskId, `使用邀请码: ${inviteCode} (共 ${allCodes.length} 个可用)`);
      await page.goto(`https://zenmux.ai/invite/${inviteCode}`, { waitUntil: "networkidle", timeout: 60_000 });
    } else {
      taskLog(taskId, "打开 ZenMux（无可用邀请码）...");
      await page.goto("https://zenmux.ai", { waitUntil: "networkidle", timeout: 60_000 });
    }
    await sleep(3000);

    // ---- 2. Sign In ----
    taskLog(taskId, "查找 Sign In...");
    for (const sel of ['button:has-text("Sign In")', 'a:has-text("Sign In")']) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) { await el.click(); break; }
      } catch (e) {}
    }
    await sleep(2000);

    // Continue with Email
    taskLog(taskId, "点击 Continue with Email...");
    try {
      const emailBtn = page.locator('button:has-text("Continue with Email")').first();
      if (await emailBtn.isVisible({ timeout: 5000 })) await emailBtn.click();
    } catch (e) {}
    await sleep(2500);

    // ---- 3. 填邮箱 ----
    let emailInput = null;
    for (const sel of ['input[id="email"]', 'input[type="email"]', 'input[placeholder*="email" i]']) {
      try {
        const els = await page.$$(sel);
        for (const el of els) {
          if (await el.isVisible()) { emailInput = el; break; }
        }
        if (emailInput) break;
      } catch (e) {}
    }
    if (!emailInput) { result.error = "找不到邮箱输入框"; return result; }
    await emailInput.click({ clickCount: 3 });
    await emailInput.fill(email);
    taskLog(taskId, `已输入邮箱: ${email}`);
    await sleep(1000);

    // ---- 4. 邀请码（如果页面有单独输入框且未通过链接自动填入） ----
    if (inviteCode) {
      for (const sel of ['input[placeholder*="invite" i]', 'input[placeholder*="邀请" i]']) {
        try {
          const els = await page.$$(sel);
          for (const el of els) {
            if (await el.isVisible().catch(() => false)) {
              const val = await el.inputValue().catch(() => "");
              if (!val) {
                await el.click({ clickCount: 3 });
                await el.fill(inviteCode);
                taskLog(taskId, `已输入邀请码: ${inviteCode}`);
              }
              break;
            }
          }
        } catch (e) {}
      }
    }

    // ---- 5. Turnstile（先探测是否需要打码，再决定是否调用 CapSolver） ----
    taskLog(taskId, "检测是否需要 Turnstile 打码...");

    // 先等一下，看 Turnstile managed 模式是否会自动通过
    let turnstileSolved = false;
    let needCapSolver = false;

    // 检测页面状态：是否有 Turnstile widget、Send 按钮是否已启用
    async function detectTurnstileState() {
      return await page.evaluate(() => {
        const result = {
          hasWidget: false,
          hasToken: false,
          sendEnabled: false,
          sendDisabled: false,
        };
        // 是否存在 turnstile widget / iframe / 输入框
        const hasIframe = !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        const hasInput = !!document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
        const hasContainer = !!document.querySelector('[data-sitekey], .cf-turnstile, [class*="turnstile" i]');
        result.hasWidget = hasIframe || hasInput || hasContainer;

        // 是否已有 token（managed 模式自动通过）
        const tokenInputs = document.querySelectorAll('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
        for (const input of tokenInputs) {
          if (input.value && input.value.length > 20) { result.hasToken = true; break; }
        }

        // Send 按钮状态
        const send = Array.from(document.querySelectorAll("button")).filter(e => e.offsetParent).find(b => (b.textContent || "").includes("Send"));
        if (send) {
          result.sendEnabled = !send.disabled;
          result.sendDisabled = send.disabled;
        }
        return result;
      });
    }

    // 先等最多 8 秒，看是否自动通过 / Send 是否已启用
    for (let i = 0; i < 8; i++) {
      const st = await detectTurnstileState();
      if (st.hasToken || st.sendEnabled) {
        turnstileSolved = true;
        taskLog(taskId, `✓ Turnstile 自动通过 / Send 已启用，无需打码`);
        break;
      }
      // 还没通过，但存在 widget 且 Send 被禁用 → 需要打码
      if (st.hasWidget && st.sendDisabled) {
        // 再等一会确认不是刚加载
        if (i >= 2) {
          needCapSolver = true;
          break;
        }
      }
      // 没有 widget 且 Send 已启用 → 不需要打码
      if (!st.hasWidget && st.sendEnabled) {
        turnstileSolved = true;
        taskLog(taskId, `✓ 页面无 Turnstile，Send 已启用，无需打码`);
        break;
      }
      await sleep(1000);
    }

    // 确认一次最终状态
    if (!turnstileSolved) {
      const st = await detectTurnstileState();
      if (st.hasToken || st.sendEnabled) {
        turnstileSolved = true;
        taskLog(taskId, `✓ Send 已启用，无需打码`);
      } else if (st.hasWidget && st.sendDisabled) {
        needCapSolver = true;
      } else if (!st.hasWidget) {
        // 没有 widget，可能页面结构不同，标记为已解决避免卡住
        turnstileSolved = true;
        taskLog(taskId, `⚠ 未检测到 Turnstile widget，跳过打码`);
      }
    }

    // 只有确认需要打码时才调用 CapSolver（省钱）。失败自动重试最多 3 次。
    if (needCapSolver && !turnstileSolved && CONFIG.CAPSOLVER_API_KEY) {
      // 提取 sitekey
      let sitekey = await page.evaluate(() => {
        const container = document.querySelector('[data-sitekey]');
        if (container) return container.getAttribute("data-sitekey");
        const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        if (iframe) { const m = iframe.src.match(/sitekey=([^&]+)/); if (m) return decodeURIComponent(m[1]); }
        return null;
      });

      if (!sitekey) {
        const cfRequests = [];
        const handler = req => { if (req.url().includes('challenges.cloudflare.com/turnstile')) cfRequests.push(req.url()); };
        page.on('request', handler);
        await sleep(2000);
        page.off('request', handler);
        for (const url of cfRequests) {
          const m = url.match(/\/0x[A-Fa-f0-9]{20,}\//);
          if (m) { sitekey = m[0].replace(/\//g, ''); break; }
        }
      }
      if (!sitekey) sitekey = "0x4AAAAAAB3vWB8HhhtIcASj";

      taskLog(taskId, `检测到需要 Turnstile 打码，sitekey: ${sitekey.slice(0, 20)}...`);

      const MAX_TURNSTILE_RETRY = 3;
      for (let attempt = 1; attempt <= MAX_TURNSTILE_RETRY && !turnstileSolved; attempt++) {
        taskLog(taskId, `调用 CapSolver (第 ${attempt}/${MAX_TURNSTILE_RETRY} 次)...`);
        try {
          const solution = await solveTurnstile({
            apiKey: CONFIG.CAPSOLVER_API_KEY,
            websiteURL: page.url(),
            websiteKey: sitekey,
          });

          taskLog(taskId, `CapSolver token: ${solution.token.slice(0, 30)}...`);

          // 注入 token + 调用 callback
          const injected = await page.evaluate((token) => {
            const inputs = document.querySelectorAll('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
            for (const input of inputs) {
              input.value = token;
              input.dispatchEvent(new Event("change", { bubbles: true }));
              input.dispatchEvent(new Event("input", { bubbles: true }));
            }
            let cbCalled = false;
            if (typeof window.__tsCallback === "function") {
              try { window.__tsCallback(token); cbCalled = true; } catch (e) {}
            }
            return cbCalled;
          }, solution.token);

          if (injected) {
            turnstileSolved = true;
            taskLog(taskId, "✓ Turnstile 已解决 (callback 已调用)");
          } else {
            // 备用: 直接设置 input
            await page.evaluate((token) => {
              let input = document.querySelector('input[name="cf-turnstile-response"]');
              if (!input) {
                input = document.createElement("input");
                input.type = "hidden";
                input.name = "cf-turnstile-response";
                document.body.appendChild(input);
              }
              input.value = token;
            }, solution.token);
            turnstileSolved = true;
            taskLog(taskId, "✓ Turnstile 已解决 (备用注入)");
          }
        } catch (e) {
          taskLog(taskId, `CapSolver 第 ${attempt} 次失败: ${e.message}`);
          if (attempt < MAX_TURNSTILE_RETRY) {
            taskLog(taskId, "等待 2s 后重试...");
            await sleep(2000);
          }
        }
      }
      if (!turnstileSolved) {
        taskLog(taskId, `⚠ Turnstile 打码 ${MAX_TURNSTILE_RETRY} 次均失败`);
      }
    } else if (!turnstileSolved) {
      taskLog(taskId, "未确认是否需要打码，等待 Turnstile 自动通过...");
    }

    // 回退: 等待自动通过
    if (!turnstileSolved) {
      taskLog(taskId, "等待 Turnstile 自动通过...");
      const start = Date.now();
      while (Date.now() - start < 60_000) {
        const token = await page.evaluate(() => {
          const inputs = document.querySelectorAll('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
          for (const input of inputs) { if (input.value?.length > 20) return input.value; }
          return null;
        });
        if (token) { turnstileSolved = true; break; }
        await sleep(1500);
      }
    }

    // ---- 6. 等待 Send Email 按钮启用 ----
    if (turnstileSolved) {
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        const enabled = await page.evaluate(() => {
          const send = Array.from(document.querySelectorAll("button")).filter(e => e.offsetParent).find(b => (b.textContent || "").includes("Send"));
          return send ? !send.disabled : false;
        });
        if (enabled) { taskLog(taskId, "✓ Send Email 按钮已启用"); break; }
      }
    }

    // ---- 7+8. 点击发送验证码并获取（第1轮等65s，第2轮等15s，都没收到就跳过）----
    // 第1轮：65s（覆盖邮件投递延迟 + ZenMux Send 重发冷却60s）
    // 第2轮：15s（重发冷却刚结束，邮件通常已到，短等即可）
    // 都没收到 → 直接跳过该账号
    const SEND_ROUNDS = [
      { wait: 65_000, label: "第1轮（等65s）" },
      { wait: 15_000, label: "第2轮（等15s）" },
    ];
    let code = null;
    for (let round = 0; round < SEND_ROUNDS.length && !code; round++) {
      const { wait, label } = SEND_ROUNDS[round];
      taskLog(taskId, round === 0 ? `点击发送验证码... (${label})` : `未收到验证码，重新点击发送... (${label})`);

      // 找 Send 按钮
      let sendBtn = null;
      for (const sel of ['button:has-text("Send Email")', 'button:has-text("Send")']) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 2000 })) { sendBtn = el; break; }
        } catch (e) {}
      }
      if (sendBtn) {
        const isDisabled = await sendBtn.isDisabled().catch(() => false);
        if (isDisabled) {
          await page.evaluate(() => {
            document.querySelectorAll('button[disabled]').forEach((btn) => {
              if ((btn.textContent || "").toLowerCase().includes("send")) {
                btn.disabled = false;
                btn.removeAttribute("disabled");
              }
            });
          });
        }
        await sendBtn.click({ force: true });
      }

      // 点击发送后，邮件投递有延迟；先等 1 秒再开始轮询
      await sleep(1000);
      // 记录发送验证码的时刻，只接受这之后到达的邮件（避免读到旧验证码）
      const codeSendTime = Date.now();
      // 直接用 hotmail_helper 取码，本轮等待 wait 毫秒
      code = await fetchVerificationCode(email, refresh_token, client_id, taskId, codeSendTime, wait);
      if (code) {
        taskLog(taskId, `验证码: ${code}`);
        break;
      }
    }
    if (!code) { result.error = "获取验证码超时（两轮均未收到）"; return result; }

    // ---- 9. 输入验证码 ----
    await sleep(2000);

    // 先尝试 OTP 多框
    const otpInputs = await page.$$('input[maxlength="1"]');
    if (otpInputs.length === 6) {
      for (let i = 0; i < 6; i++) {
        await otpInputs[i].click();
        await otpInputs[i].fill(code[i]);
        await sleep(100);
      }
      taskLog(taskId, "已输入验证码 (多框 OTP)");
    } else {
      // 单框 OTP: 用 type() 触发 React onChange
      const otpSingle = await page.$('input.otpNativeInput-LCOdN2Gu, input[maxlength="6"]');
      if (otpSingle && await otpSingle.isVisible().catch(() => false)) {
        await otpSingle.click();
        await otpSingle.type(code, { delay: 100 });
        taskLog(taskId, "已输入验证码 (单框 OTP type)");
      } else {
        // 普通输入框
        for (const sel of ['input[placeholder*="code" i]', 'input[type="text"]']) {
          try {
            const els = await page.$$(sel);
            for (const el of els) {
              if (await el.isVisible().catch(() => false)) {
                await el.click({ clickCount: 3 });
                await el.type(code, { delay: 100 });
                taskLog(taskId, "已输入验证码 (普通输入框)");
                break;
              }
            }
          } catch (e) {}
        }
      }
    }

    taskLog(taskId, "验证码已输入，等待登录...");

    // ---- 9.5 二次 Turnstile 探测（填完验证码后可能再次出现） ----
    // 提交验证码后，ZenMux 有时会要求二次 Turnstile 验证
    // 复用上面的 detectTurnstileState 逻辑探测，需要时再打码
    async function detectTurnstileState2() {
      return await page.evaluate(() => {
        const result = { hasWidget: false, hasToken: false, submitEnabled: false, submitDisabled: false };
        // 任意验证 widget：Turnstile / reCAPTCHA / hCaptcha
        const hasTurnstile = !!document.querySelector('iframe[src*="challenges.cloudflare.com"], input[name="cf-turnstile-response"], [data-sitekey], .cf-turnstile, [class*="turnstile" i]');
        const hasRecaptcha = !!document.querySelector('.g-recaptcha, iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"], #g-recaptcha-response');
        const hasHcaptcha = !!document.querySelector('iframe[src*="hcaptcha.com"], .h-captcha, textarea[name="h-captcha-response"]');
        result.hasWidget = hasTurnstile || hasRecaptcha || hasHcaptcha;
        // Turnstile token
        const tokenInputs = document.querySelectorAll('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], #g-recaptcha-response, textarea[name="h-captcha-response"]');
        for (const input of tokenInputs) {
          if (input.value && input.value.length > 20) { result.hasToken = true; break; }
        }
        // 找提交/确认按钮（Verify/Continue/Submit/Sign in 等）
        const btns = Array.from(document.querySelectorAll("button")).filter(e => e.offsetParent);
        const submit = btns.find(b => {
          const t = (b.textContent || "").toLowerCase();
          return t.includes("verify") || t.includes("continue") || t.includes("submit") || t.includes("sign in") || t.includes("confirm") || t.includes("登录") || t.includes("验证") || t.includes("确认");
        });
        if (submit) {
          result.submitEnabled = !submit.disabled;
          result.submitDisabled = submit.disabled;
        }
        return result;
      });
    }

    // 给页面时间渲染可能的二次验证
    await sleep(2000);

    // 探测是否出现二次验证（Turnstile / reCAPTCHA / hCaptcha 都算）
    // 最多等 8 秒确认；只要出现验证 widget 且没有 token，就需要打码
    let needSecondCapSolver = false;
    for (let i = 0; i < 8; i++) {
      const st = await detectTurnstileState2();
      // 已有 token 或提交按钮已启用 → 不需要打码
      if (st.hasToken || st.submitEnabled) {
        break;
      }
      // 出现了任何验证 widget 且无 token → 需要打码（确认 1 次避免误判）
      if (st.hasWidget && !st.hasToken) {
        if (i >= 1) { needSecondCapSolver = true; break; }
      }
      // 已登录成功（URL 跳转）→ 无需处理
      const url = page.url();
      if (url.includes("/chat") || url.includes("/settings") || (url.includes("zenmux.ai") && !url.includes("/sign") && !url.includes("/login") && !url.includes("/verify"))) {
        break;
      }
      await sleep(1000);
    }

    if (needSecondCapSolver) {
      taskLog(taskId, "⚠ 填完验证码后检测到二次验证，识别类型并打码...");
      try {
        // 探测二次验证类型：Cloudflare Turnstile / reCAPTCHA v2 / reCAPTCHA v3 / hCaptcha
        const probe = await page.evaluate(() => {
          const r = { type: null, sitekey: null, action: null };
          // reCAPTCHA（优先判断，因为 v2/v3 都用 .g-recaptcha 或 recaptcha iframe）
          const recaptchaDiv = document.querySelector('.g-recaptcha, [data-sitekey]:not([data-sitekey*="0x"])');
          const recaptchaIframe = document.querySelector('iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"]');
          if (recaptchaIframe || recaptchaDiv) {
            r.type = "recaptcha";
            // sitekey
            const c = document.querySelector('.g-recaptcha[data-sitekey], [data-sitekey]');
            if (c) r.sitekey = c.getAttribute("data-sitekey");
            if (recaptchaIframe) {
              const m = recaptchaIframe.src.match(/[?&]k=([^&]+)/);
              if (m) r.sitekey = decodeURIComponent(m[1]);
            }
            // action（v3 用）
            const sc = Array.from(document.querySelectorAll('script')).find(s => /grecaptcha\.execute/.test(s.textContent || ''));
            if (sc) { const m = (sc.textContent || '').match(/grecaptcha\.execute\([^,]+,\s*\{action:\s*['"]([^'"]+)['"]/); if (m) r.action = m[1]; }
            // 判断 v3：有 grecaptcha.execute 且无可见 checkbox
            if (sc && !document.querySelector('.g-recaptcha')) r.type = "recaptcha_v3";
          }
          // Cloudflare Turnstile
          if (document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [class*="turnstile" i]')) {
            r.type = "turnstile";
            const c = document.querySelector('[data-sitekey]');
            if (c) r.sitekey = c.getAttribute("data-sitekey");
            const i = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
            if (i) { const m = i.src.match(/sitekey=([^&]+)/); if (m) r.sitekey = decodeURIComponent(m[1]); }
          }
          // hCaptcha
          if (document.querySelector('iframe[src*="hcaptcha.com"], .h-captcha')) r.type = r.type || "hcaptcha";
          return r;
        });

        let sitekey = probe.sitekey;
        if (!sitekey && probe.type === "turnstile") {
          const cfRequests = [];
          const handler = req => { if (req.url().includes('challenges.cloudflare.com/turnstile')) cfRequests.push(req.url()); };
          page.on('request', handler); await sleep(2000); page.off('request', handler);
          for (const url of cfRequests) { const m = url.match(/\/0x[A-Fa-f0-9]{20,}\//); if (m) { sitekey = m[0].replace(/\//g, ''); break; } }
        }
        if (!sitekey && probe.type === "turnstile") sitekey = "0x4AAAAAAB3vWB8HhhtIcASj";
        if (!sitekey && probe.type === "recaptcha") sitekey = "6Le-wvkSVVABBPBdvLkUkqXpHcKk1mGpHw"; // 通用兜底，实际应从页面取

        const solved = await solveSecondaryCaptcha(page, taskId, probe, sitekey);
        // 打码成功后，等页面反应并点提交
        await sleep(1500);
        await clickSecondarySubmit(page, taskId);
      } catch (e) {
        taskLog(taskId, `二次打码失败: ${e.message}`);
      }
    } else {
      taskLog(taskId, "✓ 未检测到二次 Turnstile，无需二次打码");
    }

    // ---- 10. 等待登录 ----
    let loginOk = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const url = page.url();
      const onOAuth = url.includes("accounts.google.com") || url.includes("github.com/login");
      if (onOAuth) break;
      // 注意：/verify 是验证码页，不是登录成功页，不能算登录完成
      if (url.includes("/chat") || url.includes("/settings") ||
        (url.includes("zenmux.ai") && !url.includes("/sign") && !url.includes("/login") && !url.includes("/verify"))) {
        loginOk = true;
        break;
      }
    }

    if (loginOk) {
      const cookies = await context.cookies();
      const sessionId = cookies.find((c) => c.name === "sessionId");

      // 二次确认：sessionId 必须存在，且调用 referral/info 不报 401，才算真正登录成功
      // 避免误停在 /verify 等中间页时拿到死 session
      let trulyLoggedIn = !!sessionId?.value;
      if (trulyLoggedIn) {
        try {
          const probe = await page.evaluate(async () => {
            const r = await fetch("/api/referral/info", { headers: { "Accept": "application/json" }, credentials: "include" });
            return r.ok ? await r.json() : { _status: r.status };
          });
          if (probe && probe._status === 401) {
            trulyLoggedIn = false;
            taskLog(taskId, `⚠ 拿到 sessionId 但 referral/info 返回 401，登录未真正完成`);
          }
        } catch (e) {}
      }

      if (!trulyLoggedIn) {
        result.error = sessionId?.value ? "登录态无效（session 未生效）" : "登录流程未完成（无 sessionId）";
        taskLog(taskId, `❌ 注册失败: ${email} (${result.error})`);
        // 失败时截图，便于排查"验证码对却登录失败"
        await debugScreenshot(page, email, "login_invalid", taskId);
      } else {
        const storageState = await context.storageState();
        const statePath = path.join(SESSIONS_DIR, `${email.replace(/[@.]/g, "_")}.json`);
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(storageState, null, 2));

        result.success = true;
        result.sessionId = sessionId?.value || null;
        taskLog(taskId, `✅ 注册成功: ${email} | Session: ${result.sessionId}`);

        // 保存结果
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
        const summaryPath = path.join(RESULTS_DIR, "summary.jsonl");
        fs.appendFileSync(summaryPath, JSON.stringify({
          email, timestamp: new Date().toISOString(), success: true,
          sessionId: result.sessionId, statePath,
        }) + "\n");

        // 自动提取该账号的邀请码（用于后续轮换）
        await extractInviteCode(page, email, taskId);

        // 自动创建 API key：Pay API（按量付费 sk-ai-v1）+ Platform API（平台管理 sk-mg-v1）
        await ensureApiKey(page, email, taskId, "pay");
        await ensureApiKey(page, email, taskId, "platform");
      }
    } else {
      result.error = "登录流程未完成";
      taskLog(taskId, `❌ 注册失败: ${email}`);
      // 失败时截图（停在哪个页面、有没有错误提示一目了然）
      await debugScreenshot(page, email, "login_timeout", taskId);
    }
  } catch (e) {
    result.error = e.message;
    taskLog(taskId, `❌ 注册出错: ${e.message}`);
    try { await debugScreenshot(page, email, "exception", taskId); } catch (_) {}
  } finally {
    // 移除注册中状态
    registeringAccounts.delete(email.toLowerCase());
    if (browser) await browser.close();
    taskLog(taskId, `结束注册: ${email} | 耗时 ${Math.round((Date.now() - startedAt) / 1000)}s | ${result.success ? "成功" : "失败"}`);
  }
  return result;
}

// ============================================================
// 原生 HTTP 路由
// ============================================================

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

function serveStatic(req, res) {
  let filePath = path.join(__dirname, "public", req.url === "/" ? "index.html" : req.url);
  filePath = path.normalize(filePath);
  // 防止目录遍历
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end("Not Found"); return;
  }
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType, "Content-Length": content.length });
  res.end(content);
}

async function handleRequest(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    // ---- API 路由 ----

    // 日志轮询
    if (pathname === "/api/logs" && req.method === "GET") {
      const since = parseInt(url.searchParams.get("since") || "0");
      const logs = logRing.filter((l) => l.seq > since);
      return json(res, { ok: true, logs, lastSeq: logSeq });
    }

    // 账号列表
    if (pathname === "/api/accounts" && req.method === "GET") {
      const accounts = loadAccounts();
      const sessions = loadSessions();
      const enriched = accounts.map((a) => {
        const session = sessions.find((s) => s.email.toLowerCase() === a.email.toLowerCase());
        const isRegistering = registeringAccounts.has(a.email.toLowerCase());
        return {
          ...a,
          registered: !!session,
          registering: isRegistering,
          sessionId: session?.sessionId || null,
          refresh_token: "***"
        };
      });
      return json(res, { ok: true, accounts: enriched });
    }

    // 添加账号
    if (pathname === "/api/accounts" && req.method === "POST") {
      const body = await parseBody(req);
      const { email, password, client_id, refresh_token } = body;
      if (!email || !refresh_token || !client_id) return json(res, { ok: false, error: "缺少必要字段" }, 400);
      const accounts = loadAccounts();
      if (accounts.find((a) => a.email.toLowerCase() === email.toLowerCase())) return json(res, { ok: false, error: "账号已存在" }, 409);
      accounts.push({ email, password: password || "", client_id, refresh_token });
      saveAccounts(accounts);
      return json(res, { ok: true });
    }

    // 删除账号
    if (pathname.startsWith("/api/accounts/") && req.method === "DELETE") {
      const email = decodeURIComponent(pathname.slice("/api/accounts/".length));
      let accounts = loadAccounts();
      accounts = accounts.filter((a) => a.email.toLowerCase() !== email.toLowerCase());
      saveAccounts(accounts);
      return json(res, { ok: true });
    }

    // 切换账号"跳过注册"标记
    if (pathname.startsWith("/api/accounts/") && req.method === "PATCH") {
      const email = decodeURIComponent(pathname.slice("/api/accounts/".length));
      const body = await parseBody(req);
      const accounts = loadAccounts();
      const acc = accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
      if (!acc) return json(res, { ok: false, error: "未找到账号" }, 404);
      if (typeof body.skip === "boolean") acc.skip = body.skip;
      saveAccounts(accounts);
      return json(res, { ok: true, skip: !!acc.skip });
    }

    // 批量导入
    if (pathname === "/api/accounts/import" && req.method === "POST") {
      const body = await parseBody(req);
      const { accounts: newAccounts } = body;
      if (!Array.isArray(newAccounts)) return json(res, { ok: false, error: "格式错误" }, 400);
      const existing = loadAccounts();
      let added = 0;
      for (const a of newAccounts) {
        if (!a.email || !a.refresh_token || !a.client_id) continue;
        if (existing.find((e) => e.email.toLowerCase() === a.email.toLowerCase())) continue;
        existing.push({ email: a.email, password: a.password || "", client_id: a.client_id, refresh_token: a.refresh_token });
        added++;
      }
      saveAccounts(existing);
      return json(res, { ok: true, added });
    }

    // 注册结果
    if (pathname === "/api/results" && req.method === "GET") {
      return json(res, { ok: true, results: loadResults() });
    }

    // Sessions
    if (pathname === "/api/sessions" && req.method === "GET") {
      return json(res, { ok: true, sessions: loadSessions() });
    }

    // 删除 session
    if (pathname.startsWith("/api/sessions/") && req.method === "DELETE") {
      const email = decodeURIComponent(pathname.slice("/api/sessions/".length));
      const filename = email.replace(/[@.]/g, "_") + ".json";
      const filepath = path.join(SESSIONS_DIR, filename);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
      return json(res, { ok: true });
    }

    // 配置 (GET)
    if (pathname === "/api/config" && req.method === "GET") {
      return json(res, {
        ok: true,
        config: {
          inviteCodes: CONFIG.INVITE_CODES,
          autoInviteCodes: loadSavedInviteCodes(),
          allInviteCodes: getAllInviteCodes(),
          capsolverKey: CONFIG.CAPSOLVER_API_KEY ? CONFIG.CAPSOLVER_API_KEY.slice(0, 12) + "..." : "",
          headless: CONFIG.HEADLESS,
          hotmailApi: CONFIG.HOTMAIL_API_BASE,
          concurrency: CONFIG.CONCURRENCY,
          maxConcurrency: 20,
          proxyUrl: CONFIG.PROXY_URL || "",
        },
      });
    }

    // 配置 (POST)
    if (pathname === "/api/config" && req.method === "POST") {
      const body = await parseBody(req);
      if (body.inviteCodes !== undefined) CONFIG.INVITE_CODES = body.inviteCodes;
      if (body.headless !== undefined) CONFIG.HEADLESS = body.headless;
      // 动态调整并发数（仅在无注册任务时生效，避免中途改信号量）
      if (body.concurrency !== undefined) {
        if (registering) {
          return json(res, { ok: false, error: "注册进行中，无法调整并发数" }, 400);
        }
        const n = parseInt(body.concurrency, 10);
        if (isNaN(n) || n < 1 || n > 20) {
          return json(res, { ok: false, error: "并发数需在 1-20 之间" }, 400);
        }
        CONFIG.CONCURRENCY = n;
        regSemaphore.max = n;
        updateEnvFile({ CONCURRENCY: String(n) });
        return json(res, { ok: true, concurrency: CONFIG.CONCURRENCY });
      }
      // 动态代理 URL（即时生效 + 写回 .env）
      if (body.proxyUrl !== undefined) {
        const url = String(body.proxyUrl || "").trim();
        if (url && !parseProxy(url)) {
          return json(res, { ok: false, error: "代理 URL 格式错误，应为 http://user:pass@host:port" }, 400);
        }
        CONFIG.PROXY_URL = url;
        updateEnvFile({ PROXY_URL: url });
        return json(res, { ok: true, proxyUrl: CONFIG.PROXY_URL });
      }
      return json(res, { ok: true });
    }

    // CapSolver 余额
    if (pathname === "/api/capsolver/balance" && req.method === "GET") {
      if (!CONFIG.CAPSOLVER_API_KEY) return json(res, { ok: false, error: "未配置 API Key" });
      try {
        const bal = await getBalance(CONFIG.CAPSOLVER_API_KEY);
        return json(res, { ok: true, ...bal });
      } catch (e) {
        return json(res, { ok: false, error: e.message });
      }
    }

    // hotmail_helper 状态
    if (pathname === "/api/hotmail/status" && req.method === "GET") {
      try {
        const resp = await fetch(`${CONFIG.HOTMAIL_API_BASE}/health`);
        const data = await resp.json();
        return json(res, { ok: true, ...data });
      } catch (e) {
        return json(res, { ok: false, error: "hotmail_helper 未运行" });
      }
    }

    // 触发注册
    if (pathname === "/api/register" && req.method === "POST") {
      if (registering) return json(res, { ok: false, error: "已有注册任务在运行" }, 409);
      const body = await parseBody(req);
      const { email } = body;
      const accounts = loadAccounts();
      const account = email ? accounts.find((a) => a.email.toLowerCase() === email.toLowerCase()) : null;
      if (email && !account) return json(res, { ok: false, error: "未找到账号" }, 404);

      // 检查单个账号是否已注册
      if (account) {
        const sessions = loadSessions();
        const alreadyRegistered = sessions.find((s) => s.email.toLowerCase() === account.email.toLowerCase());
        if (alreadyRegistered) {
          return json(res, { ok: false, error: `${account.email} 已经注册过了` }, 400);
        }
        if (registeringAccounts.has(account.email.toLowerCase())) {
          return json(res, { ok: false, error: `${account.email} 正在注册中` }, 400);
        }
      }

      registering = true;
      stopRequested = false;
      const taskId = `task_${Date.now()}`;
      currentTaskId = taskId;
      taskLogs.set(taskId, []);

      (async () => {
        try {
          if (account) {
            const result = await registerAccount(account, taskId);
            taskLog(taskId, `任务完成: ${result.success ? "成功" : "失败"}`);
          } else {
            // 批量注册：按 CONCURRENCY 并发派发
            const sessions = loadSessions();
            // 预先过滤出待注册账号（跳过已注册/注册中/skip）
            const pending = accounts.filter(acc =>
              !sessions.find(s => s.email.toLowerCase() === acc.email.toLowerCase()) &&
              !registeringAccounts.has(acc.email.toLowerCase()) &&
              acc.skip !== true
            );
            taskLog(taskId, `批量注册: 共 ${pending.length} 个待注册，并发 ${CONFIG.CONCURRENCY}`);

            const results = [];
            let idx = 0;
            // 派发 worker：每个 worker 抢信号量槽 → 取一个账号 → 注册 → 还槽 → 继续
            async function worker(workerId) {
              while (true) {
                if (stopRequested) return;
                const i = idx++;
                if (i >= pending.length) return;
                const acc = pending[i];
                await regSemaphore.acquire();
                try {
                  if (stopRequested) { taskLog(taskId, `⏹ 已请求停止，跳过 ${acc.email}`); return; }
                  const result = await registerAccount(acc, taskId);
                  results.push(result);
                } catch (e) {
                  results.push({ success: false, email: acc.email, error: e.message });
                } finally {
                  regSemaphore.release();
                }
              }
            }
            // 启动 CONCURRENCY 个 worker，等全部结束
            const workers = [];
            for (let w = 0; w < CONFIG.CONCURRENCY; w++) workers.push(worker(w));
            await Promise.all(workers);

            taskLog(taskId, `批量注册完成: ${results.filter(r => r.success).length} 成功, ${results.filter(r => !r.success).length} 失败`);
          }
        } catch (e) {
          taskLog(taskId, `任务出错: ${e.message}`);
        } finally {
          registering = false;
          stopRequested = false;
          currentTaskId = null;
        }
      })();

      return json(res, { ok: true, taskId });
    }

    // 停止注册
    if (pathname === "/api/register/stop" && req.method === "POST") {
      stopRequested = true;
      registering = false;
      return json(res, { ok: true });
    }

    // 注册状态
    if (pathname === "/api/register/status" && req.method === "GET") {
      return json(res, {
        ok: true,
        registering,
        currentTaskId,
        taskLogs: currentTaskId ? (taskLogs.get(currentTaskId) || []) : [],
      });
    }

    // 手动触发邀请码提取（针对已注册账号）
    if (pathname === "/api/invite-codes/extract" && req.method === "POST") {
      if (registering) return json(res, { ok: false, error: "已有注册任务在运行" }, 409);
      const body = await parseBody(req);
      const { email } = body;
      const accounts = loadAccounts();
      const account = email ? accounts.find((a) => a.email.toLowerCase() === email.toLowerCase()) : null;
      if (!account) return json(res, { ok: false, error: "未找到账号" }, 404);

      const sessions = loadSessions();
      const hasSession = sessions.find((s) => s.email.toLowerCase() === account.email.toLowerCase());
      if (!hasSession) return json(res, { ok: false, error: "该账号尚未注册，无法提取邀请码" }, 400);

      registering = true;
      const taskId = `extract_${Date.now()}`;
      currentTaskId = taskId;
      taskLogs.set(taskId, []);

      (async () => {
        let browser = null;
        try {
          const proxy = parseProxy(CONFIG.PROXY_URL);
          const launchOpts = { headless: CONFIG.HEADLESS, slowMo: CONFIG.SLOW_MO };
          if (proxy) launchOpts.proxy = proxy;
          browser = await chromium.launch(launchOpts);
          const statePath = path.join(SESSIONS_DIR, `${account.email.replace(/[@.]/g, "_")}.json`);
          const context = await browser.newContext({ storageState: statePath });
          const page = await context.newPage();
          await page.goto("https://zenmux.ai", { waitUntil: "networkidle", timeout: 60_000 });
          await sleep(2000);
          const code = await extractInviteCode(page, account.email, taskId);
          await context.close();
          if (code) {
            taskLog(taskId, `✅ 提取完成: ${account.email} → ${code}`);
          } else {
            taskLog(taskId, `❌ 未能提取到邀请码`);
          }
        } catch (e) {
          taskLog(taskId, `提取出错: ${e.message}`);
        } finally {
          registering = false;
          currentTaskId = null;
          if (browser) await browser.close();
        }
      })();

      return json(res, { ok: true, taskId });
    }

    // 获取已保存的邀请码列表
    if (pathname === "/api/invite-codes" && req.method === "GET") {
      let data = [];
      if (fs.existsSync(INVITE_CODES_FILE)) {
        try { data = JSON.parse(fs.readFileSync(INVITE_CODES_FILE, "utf-8")); } catch (e) {}
      }
      return json(res, {
        ok: true,
        saved: data,
        env: CONFIG.INVITE_CODES,
        all: getAllInviteCodes(),
      });
    }

    // 删除已保存的邀请码
    if (pathname.startsWith("/api/invite-codes/") && req.method === "DELETE") {
      const code = decodeURIComponent(pathname.slice("/api/invite-codes/".length));
      let data = [];
      if (fs.existsSync(INVITE_CODES_FILE)) {
        try { data = JSON.parse(fs.readFileSync(INVITE_CODES_FILE, "utf-8")); } catch (e) {}
      }
      data = data.filter(d => d.inviteCode !== code);
      fs.writeFileSync(INVITE_CODES_FILE, JSON.stringify(data, null, 2));
      return json(res, { ok: true });
    }

    // 获取已保存的 API key 列表
    if (pathname === "/api/api-keys" && req.method === "GET") {
      return json(res, { ok: true, keys: loadApiKeys() });
    }

    // 手动为已注册账号创建/检查 API key (pay 或 platform)
    if (pathname === "/api/api-keys/ensure" && req.method === "POST") {
      if (registering) return json(res, { ok: false, error: "已有任务在运行" }, 409);
      const body = await parseBody(req);
      const { email, type } = body;
      const keyType = (type === "platform") ? "platform" : "pay";
      const accounts = loadAccounts();
      const account = email ? accounts.find((a) => a.email.toLowerCase() === email.toLowerCase()) : null;
      if (!account) return json(res, { ok: false, error: "未找到账号" }, 404);

      const sessions = loadSessions();
      const hasSession = sessions.find((s) => s.email.toLowerCase() === account.email.toLowerCase());

      registering = true;
      const taskId = `apikey_${Date.now()}`;
      currentTaskId = taskId;
      taskLogs.set(taskId, []);

      (async () => {
        let browser = null;
        try {
          // 统一入口：用 session 跑 ensureApiKey；若返回 __needRelogin（死 session）则删 session 重新登录
          async function runEnsureOrRelogin() {
            // 无 session：先登录（流程同注册），登录成功会自动创建 pay+platform 两类 key
            if (!hasSession) {
              taskLog(taskId, `⚠ ${account.email} 无 session，先登录（流程同注册）...`);
              const regResult = await registerAccount(account, taskId);
              if (!regResult.success && !regResult.skipped) {
                taskLog(taskId, `❌ 登录失败: ${regResult.error || "未知错误"}`);
                return null;
              }
              // 登录流程已自动创建两类 key，从已保存的 key 中取目标类型
              const saved = loadApiKeys().filter(
                (k) => k.email.toLowerCase() === account.email.toLowerCase() && k.keyType === keyType
              );
              const savedKey = saved[saved.length - 1];
              taskLog(taskId, savedKey
                ? `✅ ${keyType} API key 就绪（登录时自动创建）: ${savedKey.token.slice(0, 20)}...`
                : `❌ ${keyType} API key 未找到`);
              return savedKey || null;
            }
            // 有 session：复用登录态直接查/建
            const proxy = parseProxy(CONFIG.PROXY_URL);
            const launchOpts = { headless: CONFIG.HEADLESS, slowMo: CONFIG.SLOW_MO };
            if (proxy) launchOpts.proxy = proxy;
            browser = await chromium.launch(launchOpts);
            const statePath = path.join(SESSIONS_DIR, `${account.email.replace(/[@.]/g, "_")}.json`);
            const context = await browser.newContext({ storageState: statePath });
            const page = await context.newPage();
            await page.goto("https://zenmux.ai", { waitUntil: "networkidle", timeout: 60_000 });
            await sleep(2000);
            let key = await ensureApiKey(page, account.email, taskId, keyType);
            await context.close();
            await browser.close();
            browser = null;

            // 死 session：删掉旧 session 文件，重新走登录流程
            if (key && key.__needRelogin) {
              taskLog(taskId, `🗑 删除失效 session，重新登录 ${account.email}...`);
              try {
                const deadPath = path.join(SESSIONS_DIR, `${account.email.replace(/[@.]/g, "_")}.json`);
                if (fs.existsSync(deadPath)) fs.unlinkSync(deadPath);
              } catch (e) {}
              // 标记 hasSession=false 后递归走登录分支
              hasSession = false;
              return runEnsureOrRelogin();
            }
            taskLog(taskId, key ? `✅ ${keyType} API key 就绪: ${key.token.slice(0, 20)}...` : `❌ ${keyType} API key 失败`);
            return key;
          }
          await runEnsureOrRelogin();
        } catch (e) {
          taskLog(taskId, `API key 操作出错: ${e.message}`);
        } finally {
          registering = false;
          currentTaskId = null;
          if (browser) await browser.close();
        }
      })();

      return json(res, { ok: true, taskId });
    }

    // 导出 API key 为 txt（一行一个），支持按类型过滤 ?type=pay|platform|all
    if (pathname === "/api/api-keys/export" && req.method === "GET") {
      const filterType = new URL(req.url, "http://x").searchParams.get("type") || "all";
      let keys = loadApiKeys();
      if (filterType !== "all") keys = keys.filter(k => k.keyType === filterType);
      const lines = keys.filter(k => k.token).map(k => k.token);
      const txt = lines.join("\n") + (lines.length ? "\n" : "");
      const fname = `zenmux_${filterType}_keys_${Date.now()}.txt`;
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fname}"`,
        "Content-Length": Buffer.byteLength(txt),
      });
      return res.end(txt);
    }

    // gpt-load 分组列表（用于前端下拉选）
    if (pathname === "/api/gptload/groups" && req.method === "GET") {
      const r = await gptLoadListGroups();
      return json(res, r);
    }

    // 手动把已保存的 pay key 批量导入 gpt-load 指定分组
    if (pathname === "/api/gptload/import" && req.method === "POST") {
      const body = await parseBody(req);
      const groupId = body.group_id;
      const filterType = body.type || "pay";
      let keys = loadApiKeys();
      if (filterType !== "all") keys = keys.filter(k => k.keyType === filterType);
      const tokens = keys.filter(k => k.token).map(k => k.token);
      if (!tokens.length) return json(res, { ok: false, error: "没有可导入的 key" }, 400);
      const r = await gptLoadImportKeys(groupId, tokens.join("\n"));
      return json(res, { ...r, count: tokens.length });
    }

    // ---- 静态文件 ----
    serveStatic(req, res);
  } catch (e) {
    console.error("请求处理错误:", e);
    json(res, { ok: false, error: e.message }, 500);
  }
}

// ============================================================
// 启动
// ============================================================
const server = http.createServer(handleRequest);

// ---- 一并启动 hotmail_helper（接码服务），随面板一起跑 ----
function startHotmailHelper() {
  const helperScript = path.join(__dirname, "hotmail_helper(1).py");
  if (!fs.existsSync(helperScript)) {
    console.log(`  [hotmail_helper] 未找到 ${path.basename(helperScript)}，跳过自动启动`);
    return;
  }
  const helperHost = process.env.HOTMAIL_HELPER_HOST || "127.0.0.1";
  const helperPort = parseInt(process.env.HOTMAIL_HELPER_PORT || process.env.HOTMAIL_API_BASE?.match(/:(\d+)/)?.[1] || "17373", 10);
  const env = {
    ...process.env,
    HOTMAIL_HELPER_HOST: helperHost,
    HOTMAIL_HELPER_PORT: String(helperPort),
    HOTMAIL_HELPER_PASSWORD: CONFIG.HOTMAIL_API_PASSWORD || "",
  };
  const child = spawn("python3", [helperScript], {
    cwd: __dirname,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`  [hotmail_helper] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`  [hotmail_helper] ${d}`));
  child.on("exit", (code) => console.log(`  [hotmail_helper] 进程退出 (code=${code})`));
  console.log(`  [hotmail_helper] 已启动 (PID=${child.pid}) http://${helperHost}:${helperPort}`);
}

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`\n  ZenMux 管理面板已启动: http://${CONFIG.HOST}:${CONFIG.PORT}\n`);
  const all = getAllInviteCodes();
  console.log(`  可用邀请码: ${all.length} 个 (env: ${CONFIG.INVITE_CODES.length}, 自动提取: ${loadSavedInviteCodes().length})`);
  if (all.length > 0) console.log(`  邀请码列表: ${all.join(", ")}\n`);
  console.log(`  注册时会自动提取新账号邀请码并加入轮换\n`);
  startHotmailHelper();
});
