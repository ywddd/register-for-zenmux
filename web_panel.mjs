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
import { ProxyAgent } from "undici";
import { solveTurnstile, solveRecaptchaV2, solveRecaptchaV3, solveHCaptcha, getBalance } from "./capsolver_helper.mjs";

// ZenMux 验证码 sitekey（抓包实测）
const TURNSTILE_SITEKEY = "0x4AAAAAAB3vWB8HhhtIcASj";
const RECAPTCHA_SITEKEY = "6LdN_REsAAAAAKSlH2k4VNXoCT-Fi1bv_Ufaf86t";

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

// 直调 ZenMux API（用 session 文件里的 cookie，无需浏览器，省流量）
// 注册成功后保存了 session 文件，这里直接读 cookie 发请求，不用再开浏览器加载页面。
// 返回 { ok: bool, status: number, data: any }
async function zenmuxApiRequest(email, method, reqPath, body) {
  const statePath = path.join(SESSIONS_DIR, `${email.replace(/[@.]/g, "_")}.json`);
  if (!fs.existsSync(statePath)) return { ok: false, status: 0, error: "无 session 文件" };
  let cookies = [];
  try { cookies = JSON.parse(fs.readFileSync(statePath, "utf-8")).cookies || []; }
  catch (e) { return { ok: false, status: 0, error: "session 文件损坏" }; }
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
  const ctoken = cookies.find(c => c.name === "ctoken");
  const headers = { "Accept": "application/json", "Cookie": cookieHeader };
  if (ctoken) headers["X-CSRF-Token"] = ctoken.value;
  if (body) headers["Content-Type"] = "application/json";
  // 重试：网络错误 + 500/502/503 服务端瞬时错误，最多3次
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(`https://zenmux.ai${reqPath}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
      });
      const text = await resp.text();
      let data = null; try { data = JSON.parse(text); } catch (e) { data = text; }
      if ([500, 502, 503].includes(resp.status) && attempt < 3) {
        lastErr = { ok: false, status: resp.status, data };
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      return { ok: resp.ok, status: resp.status, data };
    } catch (e) {
      lastErr = { ok: false, status: 0, error: e.message };
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  return lastErr || { ok: false, status: 0, error: "未知错误" };
}

// 直调 API 提取已登录账号的邀请码（无需浏览器）
async function extractInviteCode(email, taskId) {
  taskLog(taskId, `提取邀请码: ${email}`);
  try {
    const r = await zenmuxApiRequest(email, "GET", "/api/referral/info");
    if (r.ok && r.data) {
      // 返回结构: {success, data:{inviteCode}}；兼容直接挂在根上
      const code = r.data?.data?.inviteCode || r.data?.inviteCode;
      if (code) {
        taskLog(taskId, `✓ API 获取邀请码: ${code}`);
        saveInviteCode(email, code);
        return code;
      }
    }
    taskLog(taskId, `⚠ 未能提取到 ${email} 的邀请码 (referral/info ${r.status})`);
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
async function ensureApiKey(email, taskId, type = "pay") {
  const isPlatform = type === "platform";
  const typeName = isPlatform ? "Platform API (平台管理 sk-mg-v1)" : "Pay API (按量付费 sk-ai-v1)";
  const listPath = isPlatform ? "/api/management_key/list" : "/api/api_key/list?type=Managed";
  const createPath = isPlatform ? "/api/management_key/create" : "/api/api_key/create";
  const autoPrefix = isPlatform ? "Platform-Auto-" : "Auto-";

  taskLog(taskId, `检查/创建 ${typeName}: ${email}`);

  try {
    // 1. 直调 API 查询现有 key 列表
    const listResp = await zenmuxApiRequest(email, "GET", listPath);

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

    // 3. 直调 API 创建新 key（CSRF 头由 zenmuxApiRequest 从 ctoken cookie 自动带）
    const keyName = `${autoPrefix}${email.split("@")[0]}`;
    taskLog(taskId, `创建新 ${typeName} key: ${keyName}`);
    const createBody = isPlatform ? { name: keyName } : { name: keyName, tags: [] };
    const createResp = await zenmuxApiRequest(email, "POST", createPath, createBody);

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
  // 容错：邮件 receivedDateTime 可能略早于本地点击时刻（投递延迟/时钟偏差），给 5s 前置窗口。
  // （原 30s 太松，高并发下会漏进上次失败的旧码 → verify 报 Invalid or expired）
  const monitorStartTime = codeSendTime
    ? new Date(codeSendTime - 5_000)
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

  // 只接受发送验证码之后到达的邮件（容错 5s 前置窗口，避免旧码）
  const monitorStartTime = codeSendTime ? (codeSendTime - 5_000) : (Date.now() - 60_000);

  const helperDeadline = startTime + timeout;

  while (Date.now() < helperDeadline) {
    // 已请求停止 → 立即退出轮询，不继续等邮件
    if (stopRequested) { taskLog(taskId, `⏹ 已停止，停止等验证码: ${email}`); return null; }
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


// ============================================================
// 纯 API 注册（不开浏览器，省流量）：抓包实测的接口直调
// 流程：取ctoken → get_invite_user → CapSolver Turnstile → send → 取码 →
//       verify → (referral/info 非200则) CapSolver reCAPTCHA → recaptcha/verification →
//       referral/info 200 → 保存session → 提取邀请码/建key（复用直调）
// 代理可选：配了 PROXY_URL 就走代理（undici ProxyAgent），否则直连
// ============================================================
async function registerAccountApi(account, taskId) {
  const { email, refresh_token, client_id } = account;
  const result = { success: false, email, sessionId: null, error: null };
  const startedAt = Date.now();

  if (account.skip === true) { result.error = "已跳过"; return { ...result, skipped: true }; }
  const existing = loadSessions().find((s) => s.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    taskLog(taskId, `⚠ ${email} 已注册过，跳过`);
    return { ...result, sessionId: existing.sessionId, error: "已注册过，跳过", skipped: true };
  }
  registeringAccounts.add(email.toLowerCase());
  taskLog(taskId, `开始注册(API): ${email}`);

  // cookie jar + 可选代理
  const cookies = {};
  let dispatcher = null;
  if (CONFIG.PROXY_URL) {
    try { dispatcher = new ProxyAgent(CONFIG.PROXY_URL); taskLog(taskId, `使用代理: ${CONFIG.PROXY_URL.replace(/:[^:@]+@/, ":***@")}`); }
    catch (e) { taskLog(taskId, `⚠ 代理初始化失败，改直连: ${e.message}`); }
  }
  const baseOpts = dispatcher ? { dispatcher } : {};
  const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const parseSetCookie = (headers) => {
    const sc = headers.get("set-cookie"); if (!sc) return;
    for (const c of sc.split(/,(?=[^;]+?=)/)) {
      const m = c.match(/^([^=;]+)=([^;]*)/);
      if (m) cookies[m[1].trim()] = m[2].trim();
    }
  };
  async function api(method, urlPath, body) {
    const ct = cookies["ctoken"] || "";
    const url = `https://zenmux.ai${urlPath}${urlPath.includes("?") ? "&" : "?"}ctoken=${ct}`;
    const headers = { Accept: "application/json", Cookie: cookieHeader() };
    if (body) headers["Content-Type"] = "application/json";
    // 重试：网络错误(fetch failed) + 服务端瞬时错误(500/502/503)，最多3次
    // （429限流/400逻辑错误不重试——重试也没用）
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, ...baseOpts });
        parseSetCookie(r.headers);
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch { data = text; }
        if ([500, 502, 503].includes(r.status) && attempt < 3) {
          lastErr = new Error(`HTTP ${r.status} ${JSON.stringify(data).slice(0, 80)}`);
          await sleep(2000 * attempt);
          continue;
        }
        return { status: r.status, data };
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }
    throw lastErr;
  }

  try {
    if (stopRequested) { result.error = "已停止"; return result; }

    // 0. 取 ctoken（带重试，代理可能抽风）
    let r0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { r0 = await fetch("https://zenmux.ai/api/frontend/public/appData", baseOpts); break; }
      catch (e) { if (attempt < 3) await sleep(2000 * attempt); else throw e; }
    }
    parseSetCookie(r0.headers);
    if (!cookies["ctoken"]) throw new Error("未取到 ctoken");

    // 1. 绑定邀请码
    const allCodes = getAllInviteCodes();
    const inviteCode = allCodes.length > 0 ? allCodes[Math.floor(Math.random() * allCodes.length)] : "";
    if (inviteCode) {
      taskLog(taskId, `使用邀请码: ${inviteCode}`);
      const r1 = await api("GET", `/api/get_invite_user?inviteCode=${inviteCode}`);
      if (r1.status !== 200) taskLog(taskId, `⚠ get_invite_user ${r1.status}`);
    }

    if (stopRequested) { result.error = "已停止"; return result; }

    // 2. Turnstile
    taskLog(taskId, "CapSolver 解 Turnstile...");
    const ts = await solveTurnstile({ apiKey: CONFIG.CAPSOLVER_API_KEY, websiteURL: "https://zenmux.ai", websiteKey: TURNSTILE_SITEKEY });
    taskLog(taskId, `✓ Turnstile token: ${ts.token.slice(0, 24)}...`);

    // 3. send
    taskLog(taskId, `[${email}] 发送验证码...`);
    const r2 = await api("POST", "/api/login/email/code/send", { email, token: ts.token });
    taskLog(taskId, `[${email}] send: ${r2.status}`);
    if (r2.status !== 200) throw new Error(`发送验证码失败 ${r2.status} ${JSON.stringify(r2.data).slice(0, 100)}`);

    if (stopRequested) { result.error = "已停止"; return result; }

    // 4. 取验证码（复用 hotmail_helper，带时间过滤）
    const code = await fetchVerificationCode(email, refresh_token, client_id, taskId, Date.now(), 65_000);
    if (!code) throw new Error("获取验证码超时");
    taskLog(taskId, `[${email}] 验证码: ${code}`);

    if (stopRequested) { result.error = "已停止"; return result; }

    // 5. verify（若报 Invalid or expired，可能是取到旧码，等新码重取重试一次）
    let r3 = await api("POST", "/api/login/email/code/verify", { email, code });
    taskLog(taskId, `[${email}] verify: ${r3.status}`);
    if (r3.status !== 200) {
      const msg = JSON.stringify(r3.data || {});
      if (/invalid|expired|无效|过期/i.test(msg)) {
        taskLog(taskId, `[${email}] 验证码无效，等 8s 重取新码重试...`);
        await sleep(8000);
        const code2 = await fetchVerificationCode(email, refresh_token, client_id, taskId, Date.now() - 60_000, 30_000);
        if (code2 && code2 !== code) {
          r3 = await api("POST", "/api/login/email/code/verify", { email, code: code2 });
          taskLog(taskId, `[${email}] verify(重试): ${r3.status}`);
        }
      }
      if (r3.status !== 200) throw new Error(`[${email}] 验证码校验失败 ${r3.status} ${JSON.stringify(r3.data).slice(0, 100)}`);
    }

    // 5.5 检查是否已登录
    let rInfo = await api("GET", "/api/referral/info");
    if (rInfo.status !== 200) {
      // 6. 需要二次 reCAPTCHA
      taskLog(taskId, `[${email}] 需二次验证，CapSolver 解 reCAPTCHA...`);
      const rc = await solveRecaptchaV2({ apiKey: CONFIG.CAPSOLVER_API_KEY, websiteURL: "https://zenmux.ai", websiteKey: RECAPTCHA_SITEKEY });
      taskLog(taskId, `[${email}] ✓ reCAPTCHA token: ${rc.token.slice(0, 24)}...`);
      const r4 = await api("POST", "/api/login/recaptcha/verification", { token: rc.token });
      taskLog(taskId, `[${email}] recaptcha: ${r4.status}`);
      if (r4.status !== 200) throw new Error(`[${email}] 二次验证失败 ${r4.status} ${JSON.stringify(r4.data).slice(0, 100)}`);
      rInfo = await api("GET", "/api/referral/info");
    }

    if (rInfo.status !== 200) throw new Error(`登录未完成 referral/info=${rInfo.status}`);

    // 7. 保存 session（storageState 格式，兼容现有面板/zenmuxApiRequest）
    const sessionId = cookies["sessionId"] || "";
    const storageState = { cookies: Object.entries(cookies).map(([name, value]) => ({ name, value, domain: "zenmux.ai", path: "/", httpOnly: false, secure: true, sameSite: "Lax" })) };
    const statePath = path.join(SESSIONS_DIR, `${email.replace(/[@.]/g, "_")}.json`);
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(storageState, null, 2));

    result.success = true;
    result.sessionId = sessionId;
    taskLog(taskId, `✅ 注册成功(API): ${email} | Session: ${sessionId}`);

    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.appendFileSync(path.join(RESULTS_DIR, "summary.jsonl"), JSON.stringify({ email, timestamp: new Date().toISOString(), success: true, sessionId, statePath }) + "\n");

    // 8. 收尾：提取邀请码 + 建 key（复用直调 API，读 session 文件）
    if (!stopRequested) {
      await extractInviteCode(email, taskId);
      await ensureApiKey(email, taskId, "pay");
      await ensureApiKey(email, taskId, "platform");
    }
  } catch (e) {
    result.error = e.message;
    taskLog(taskId, `❌ 注册出错(API): ${e.message}`);
  } finally {
    registeringAccounts.delete(email.toLowerCase());
    taskLog(taskId, `结束注册(API): ${email} | 耗时 ${Math.round((Date.now() - startedAt) / 1000)}s | ${result.success ? "成功" : "失败"}`);
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
      let added = 0, duplicate = 0, invalid = 0;
      const dupEmails = [];
      for (const a of newAccounts) {
        if (!a.email || !a.refresh_token || !a.client_id) { invalid++; continue; }
        if (existing.find((e) => e.email.toLowerCase() === a.email.toLowerCase())) { duplicate++; dupEmails.push(a.email); continue; }
        existing.push({ email: a.email, password: a.password || "", client_id: a.client_id, refresh_token: a.refresh_token });
        added++;
      }
      saveAccounts(existing);
      return json(res, { ok: true, added, duplicate, invalid, dupEmails: dupEmails.slice(0, 20) });
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
            const result = await registerAccountApi(account, taskId);
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
                  const result = await registerAccountApi(acc, taskId);
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
        try {
          // 直调 API 提取邀请码，不用开浏览器（省流量）
          const code = await extractInviteCode(account.email, taskId);
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
      let hasSession = sessions.find((s) => s.email.toLowerCase() === account.email.toLowerCase());

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
              const regResult = await registerAccountApi(account, taskId);
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
            // 有 session：直调 API 查/建（不用开浏览器，省流量）
            let key = await ensureApiKey(account.email, taskId, keyType);

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
// hotmail_helper 是关键子进程：它挂了所有取码都会失败。这里做两件事：
// 1) 监听它的 exit，崩了自动重启（最多每 5s 一次）
// 2) 面板收到 SIGINT/SIGTERM 时连带把它一起 kill，避免残留孤儿进程
let helperChild = null;
let helperStopping = false;
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
  helperChild = spawn("python3", [helperScript], {
    cwd: __dirname,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  helperChild.stdout.on("data", (d) => process.stdout.write(`  [hotmail_helper] ${d}`));
  helperChild.stderr.on("data", (d) => process.stderr.write(`  [hotmail_helper] ${d}`));
  helperChild.on("exit", (code) => {
    console.log(`  [hotmail_helper] 进程退出 (code=${code})`);
    helperChild = null;
    // 非主动停止时自动重启（5s 冷却，避免崩溃循环刷屏）
    if (!helperStopping) {
      console.log(`  [hotmail_helper] 5s 后自动重启...`);
      setTimeout(() => { if (!helperStopping) startHotmailHelper(); }, 5000);
    }
  });
  console.log(`  [hotmail_helper] 已启动 (PID=${helperChild.pid}) http://${helperHost}:${helperPort}`);
}

// ---- 全局兜底：任何未捕获异常都不让面板整个崩掉 ----
// （systemd 会重启，但自己接住能保住正在跑的其它注册任务 + 子进程）
process.on("uncaughtException", (err) => {
  console.error(`  [致命] uncaughtException: ${err?.stack || err}`);
});
process.on("unhandledRejection", (reason) => {
  console.error(`  [致命] unhandledRejection: ${reason?.stack || reason}`);
});

// 优雅退出：收到信号时 kill 掉 hotmail_helper 子进程再退出
function shutdown(sig) {
  console.log(`\n  收到 ${sig}，正在关闭（连带 hotmail_helper）...`);
  helperStopping = true;
  if (helperChild) { try { helperChild.kill("SIGTERM"); } catch (e) {} }
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`\n  ZenMux 管理面板已启动: http://${CONFIG.HOST}:${CONFIG.PORT}\n`);
  const all = getAllInviteCodes();
  console.log(`  可用邀请码: ${all.length} 个 (env: ${CONFIG.INVITE_CODES.length}, 自动提取: ${loadSavedInviteCodes().length})`);
  if (all.length > 0) console.log(`  邀请码列表: ${all.join(", ")}\n`);
  console.log(`  注册时会自动提取新账号邀请码并加入轮换\n`);
  startHotmailHelper();
});
