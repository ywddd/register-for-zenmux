#!/usr/bin/env node
/**
 * ZenMux.ai 注册机
 *
 * 使用 Playwright 自动化浏览器完成注册流程:
 * 1. 打开 zenmux.ai 登录页
 * 2. 输入邮箱
 * 3. 等待 Cloudflare Turnstile 验证
 * 4. 发送验证码
 * 5. 通过 hotmail_helper 获取验证码
 * 6. 输入验证码完成注册
 *
 * 用法:
 *   node zenmux_register.mjs                          # 交互模式，手动输入邮箱
 *   node zenmux_register.mjs --email user@outlook.com # 指定邮箱
 *   node zenmux_register.mjs --batch                  # 批量模式，使用所有可用账号
 *   node zenmux_register.mjs --batch --count 5        # 批量模式，只注册5个
 */

// 加载 .env 配置（必须在最前面）
import "dotenv/config";

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import readline from "readline";
import { solveTurnstile, getBalance } from "./capsolver_helper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

// ============================================================
// 配置（支持 .env / 环境变量 / 命令行参数）
// ============================================================
const CONFIG = {
  // ZenMux 登录页
  ZENMUX_LOGIN_URL: "https://zenmux.ai/auth/signup",

  // hotmail_helper 本地 API
  HOTMAIL_API_BASE: process.env.HOTMAIL_API_BASE || "http://127.0.0.1:17373",
  HOTMAIL_API_PASSWORD: process.env.HOTMAIL_HELPER_PASSWORD || "",

  // 账号配置目录（跨平台默认路径）
  ACCOUNTS_DIR: process.env.ACCOUNTS_DIR || path.join(HOME, ".cli-proxy-api"),

  // Microsoft OAuth 账号配置文件（默认在项目目录下）
  MS_ACCOUNTS_FILE: process.env.MS_ACCOUNTS_FILE || path.join(__dirname, "zenmux_accounts.json"),

  // Microsoft OAuth client_id (从账号配置文件读取)
  DEFAULT_CLIENT_ID: "",

  // 超时设置 (毫秒)
  TURNSTILE_TIMEOUT: 120_000,   // Turnstile 验证超时
  CODE_SEND_TIMEOUT: 30_000,    // 发送验证码超时
  CODE_FETCH_TIMEOUT: 150_000,  // 获取验证码超时 (等待邮件到达)
  CODE_FETCH_INTERVAL: 5_000,   // 轮询邮件间隔

  // 邀请码列表（逗号分隔，注册时随机选一个）
  INVITE_CODES: (process.env.ZENMUX_INVITE_CODE || "").split(",").map(s => s.trim()).filter(Boolean),

  // CapSolver 打码平台
  CAPSOLVER_API_KEY: process.env.CAPSOLVER_API_KEY || "",

  // 浏览器设置
  HEADLESS: process.env.HEADLESS !== "false",
  SLOW_MO: parseInt(process.env.SLOW_MO || "100"),
};

// ============================================================
// 工具函数
// ============================================================

function log(msg) {
  const ts = new Date().toLocaleTimeString("zh-CN");
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ============================================================
// 读取账号配置
// ============================================================

function loadAccounts() {
  const accounts = [];

  // 优先加载新的 Microsoft OAuth 账号
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
            isAuth0: false,
          });
        }
      }
      log(`从 ${CONFIG.MS_ACCOUNTS_FILE} 加载了 ${accounts.length} 个 Microsoft 账号`);
    } catch (e) {
      log(`加载 Microsoft 账号失败: ${e.message}`);
    }
  }

  // 也加载旧的 Auth0 账号（手动输入验证码模式）
  const dir = CONFIG.ACCOUNTS_DIR;
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    let auth0Count = 0;

    for (const file of files) {
      try {
        const filePath = path.join(dir, file);
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

        if (data.disabled || data.expired) continue;
        if (!data.refresh_token || !data.email) continue;

        // 检查是否已经在 Microsoft 账号列表中
        const exists = accounts.some(
          (a) => a.email.toLowerCase() === data.email.toLowerCase()
        );
        if (exists) continue;

        accounts.push({
          email: data.email,
          refresh_token: data.refresh_token,
          client_id: data.client_id || data.account_id || "",
          type: data.type || "unknown",
          isAuth0: data.type === "codex",
        });
        auth0Count++;
      } catch (e) {
        // skip invalid files
      }
    }

    if (auth0Count > 0) {
      log(`从 ${dir} 加载了 ${auth0Count} 个 Auth0 账号（需手动输入验证码）`);
    }
  }

  return accounts;
}

// ============================================================
// 通过 Microsoft Graph API 获取 access_token
// ============================================================

async function getMicrosoftAccessToken(refresh_token, client_id) {
  const tokenUrl = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

  try {
    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id,
        grant_type: "refresh_token",
        refresh_token,
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data.access_token) {
        return data.access_token;
      }
    }
  } catch (e) {
    log(`获取 access_token 失败: ${e.message}`);
  }

  return null;
}

// ============================================================
// 通过 Microsoft Graph API 获取验证码
// ============================================================

async function fetchVerificationCodeFromGraph(email, refresh_token, client_id) {
  const startTime = Date.now();
  log(`开始监听邮箱 ${email} 的验证码 (Microsoft Graph API)...`);

  // 先获取 access_token
  let accessToken = await getMicrosoftAccessToken(refresh_token, client_id);
  if (!accessToken) {
    log("无法获取 access_token");
    return null;
  }

  log("✓ 获取 access_token 成功");

  // 记录开始监听的时间，只接受这之后到达的邮件（避免读到旧验证码）
  const monitorStartTime = new Date(Date.now() - 5_000); // 容差5秒

  while (Date.now() - startTime < CONFIG.CODE_FETCH_TIMEOUT) {
    try {
      // 获取收件箱最新邮件
      const graphUrl = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=10&$orderby=receivedDateTime%20desc";

      const resp = await fetch(graphUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });

      if (resp.ok) {
        const data = await resp.json();
        const messages = data.value || [];

        for (const msg of messages) {
          if (!msg.subject) continue;

          // 检查是否是 ZenMux 的验证码邮件
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
            fromEmail.includes("noreply") && (subject.includes("code") || subject.includes("verify") || subject.includes("verification"));

          if (isZenMux) {
            // 提取验证码 (通常是6位数字)
            const content = msg.bodyPreview || msg.subject || "";
            const codeMatch = content.match(/\b(\d{6})\b/);
            if (codeMatch) {
              log(`找到验证码: ${codeMatch[1]} (主题: ${msg.subject})`);
              return codeMatch[1];
            }

            // 也检查邮件正文
            if (msg.body?.content) {
              const bodyContent = msg.body.content;
              const bodyCodeMatch = bodyContent.match(/\b(\d{6})\b/);
              if (bodyCodeMatch) {
                log(`从邮件正文找到验证码: ${bodyCodeMatch[1]}`);
                return bodyCodeMatch[1];
              }
            }
          }
        }
      } else if (resp.status === 401) {
        // Token 过期，重新获取
        accessToken = await getMicrosoftAccessToken(refresh_token, client_id);
      }
    } catch (e) {
      log(`获取邮件出错: ${e.message}`);
    }

    // 也检查垃圾邮件 (ZenMux 验证码邮件很可能进垃圾箱)
    try {
      const junkUrl = "https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages?$top=10&$orderby=receivedDateTime%20desc";

      const resp = await fetch(junkUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });

      if (resp.ok) {
        const data = await resp.json();
        const messages = data.value || [];

        for (const msg of messages) {
          if (!msg.subject) continue;

          const subject = (msg.subject || "").toLowerCase();
          const fromEmail = msg.from?.emailAddress?.address?.toLowerCase() || "";
          const preview = (msg.bodyPreview || "").toLowerCase();

          // 垃圾箱里放宽匹配：任何含6位数字的验证码邮件都尝试
          const isVerification =
            fromEmail.includes("zenmux") ||
            subject.includes("zenmux") ||
            subject.includes("verification") ||
            subject.includes("verify") ||
            subject.includes("code") ||
            (fromEmail.includes("noreply") && /\b\d{6}\b/.test(subject));

          if (isVerification) {
            const content = msg.bodyPreview || msg.subject || "";
            const codeMatch = content.match(/\b(\d{6})\b/);
            if (codeMatch) {
              log(`从垃圾邮件找到验证码: ${codeMatch[1]} (主题: ${msg.subject})`);
              return codeMatch[1];
            }
          }
        }
      }
    } catch (e) {
      // ignore junk folder errors
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r等待验证码... ${elapsed}s`);
    await sleep(CONFIG.CODE_FETCH_INTERVAL);
  }

  console.log();
  log("获取验证码超时");
  return null;
}

// ============================================================
// 通过 hotmail_helper 获取验证码 (备用)
// ============================================================

async function fetchVerificationCode(email, refresh_token, client_id) {
  const startTime = Date.now();
  log(`开始监听邮箱 ${email} 的验证码 (hotmail_helper)...`);

  while (Date.now() - startTime < CONFIG.CODE_FETCH_TIMEOUT) {
    try {
      const body = {
        email,
        refresh_token,
        client_id,
        mailbox: "INBOX",
        top: 5,
      };
      if (CONFIG.HOTMAIL_API_PASSWORD) {
        body.password = CONFIG.HOTMAIL_API_PASSWORD;
      }

      const resp = await fetch(`${CONFIG.HOTMAIL_API_BASE}/api/mail-new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (resp.ok) {
        const data = await resp.json();

        // 处理单条消息或数组
        const messages = Array.isArray(data) ? data : [data];

        for (const msg of messages) {
          if (!msg || !msg.subject) continue;

          // 检查是否是 ZenMux 的验证码邮件
          const subject = (msg.subject || "").toLowerCase();
          const from = (msg.from_email || msg.send || "").toLowerCase();
          const text = (msg.text || msg.bodyPreview || "").toLowerCase();
          const html = (msg.html || "").toLowerCase();

          const isZenMux =
            from.includes("zenmux") ||
            subject.includes("zenmux") ||
            subject.includes("verification") ||
            subject.includes("verify") ||
            subject.includes("code") ||
            text.includes("zenmux") ||
            html.includes("zenmux");

          if (isZenMux) {
            // 提取验证码 (通常是6位数字)
            const content = msg.text || msg.bodyPreview || msg.html || "";
            const codeMatch = content.match(/\b(\d{6})\b/);
            if (codeMatch) {
              log(`找到验证码: ${codeMatch[1]}`);
              return codeMatch[1];
            }

            // 也尝试从 HTML 中提取
            const htmlContent = msg.html || "";
            const htmlCodeMatch = htmlContent.match(/\b(\d{6})\b/);
            if (htmlCodeMatch) {
              log(`从HTML找到验证码: ${htmlCodeMatch[1]}`);
              return htmlCodeMatch[1];
            }
          }
        }
      }
    } catch (e) {
      log(`获取邮件出错: ${e.message}`);
    }

    // 也检查垃圾邮件
    try {
      const body = {
        email,
        refresh_token,
        client_id,
        mailbox: "Junk",
        top: 5,
      };
      if (CONFIG.HOTMAIL_API_PASSWORD) {
        body.password = CONFIG.HOTMAIL_API_PASSWORD;
      }

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

          const subject = (msg.subject || "").toLowerCase();
          const from = (msg.from_email || msg.send || "").toLowerCase();
          const text = (msg.text || msg.bodyPreview || "").toLowerCase();
          const html = (msg.html || "").toLowerCase();

          const isZenMux =
            from.includes("zenmux") ||
            subject.includes("zenmux") ||
            text.includes("zenmux") ||
            html.includes("zenmux");

          if (isZenMux) {
            const content = msg.text || msg.bodyPreview || msg.html || "";
            const codeMatch = content.match(/\b(\d{6})\b/);
            if (codeMatch) {
              log(`从垃圾邮件找到验证码: ${codeMatch[1]}`);
              return codeMatch[1];
            }
          }
        }
      }
    } catch (e) {
      // ignore junk folder errors
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r等待验证码... ${elapsed}s`);
    await sleep(CONFIG.CODE_FETCH_INTERVAL);
  }

  console.log();
  log("获取验证码超时");
  return null;
}

// ============================================================
// 保存注册结果
// ============================================================

const RESULTS_DIR = path.join(__dirname, "zenmux_results");

function saveResult(email, result) {
  // 只保存成功的结果
  if (!result.success) {
    log(`跳过保存失败的结果: ${email}`);
    return null;
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${email.replace(/[@.]/g, "_")}_${timestamp}.json`;
  const filepath = path.join(RESULTS_DIR, filename);

  const data = {
    email,
    timestamp: new Date().toISOString(),
    success: result.success,
    cookies: result.cookies || [],
    sessionId: result.sessionId || null,
    apiKey: result.apiKey || null,
    error: result.error || null,
    ...result.extra,
  };

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  log(`结果已保存: ${filepath}`);

  // 也追加到汇总文件
  const summaryPath = path.join(RESULTS_DIR, "summary.jsonl");
  fs.appendFileSync(summaryPath, JSON.stringify(data) + "\n");

  return filepath;
}

function loadResults() {
  const summaryPath = path.join(RESULTS_DIR, "summary.jsonl");
  if (!fs.existsSync(summaryPath)) return [];

  const results = [];
  const lines = fs.readFileSync(summaryPath, "utf-8").split("\n");
  for (const line of lines) {
    if (line.trim()) {
      try {
        results.push(JSON.parse(line));
      } catch (e) {}
    }
  }
  return results;
}

function showSummary() {
  const results = loadResults();
  if (results.length === 0) {
    log("没有注册记录");
    return;
  }

  const success = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  log(`\n${"=".repeat(60)}`);
  log("注册汇总:");
  log(`  总计: ${results.length}`);
  log(`  成功: ${success.length}`);
  log(`  失败: ${failed.length}`);

  if (success.length > 0) {
    log("\n成功的账号:");
    for (const r of success) {
      log(`  ✓ ${r.email} (${r.timestamp})`);
    }
  }

  if (failed.length > 0) {
    log("\n失败的账号:");
    for (const r of failed) {
      log(`  ✗ ${r.email}: ${r.error || "未知错误"}`);
    }
  }

  log(`\n详细结果目录: ${RESULTS_DIR}`);
  log(`${"=".repeat(60)}`);
}

// ============================================================
// 注册流程
// ============================================================

async function registerAccount(account) {
  const { email, refresh_token, client_id } = account;
  log(`\n${"=".repeat(60)}`);
  log(`开始注册: ${email}`);
  log(`${"=".repeat(60)}`);

  const result = {
    success: false,
    cookies: [],
    sessionId: null,
    apiKey: null,
    error: null,
    extra: {},
  };

  let browser = null;
  let context = null;

  try {
    // 启动浏览器
    browser = await chromium.launch({
      headless: CONFIG.HEADLESS,
      slowMo: CONFIG.SLOW_MO,
    });

    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });

    const page = await context.newPage();

    // 在页面加载早期 patch turnstile.render，拦截 callback
    // 这样 CapSolver 的 token 能通过 callback 通知 React 验证通过，启用 Send Email 按钮
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

    // 监听网络请求，捕获 API 响应
    let codeSendResult = null;

    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("api/login/email/code/send")) {
        try {
          codeSendResult = await response.json();
          log(`验证码发送API响应: ${JSON.stringify(codeSendResult)}`);
        } catch (e) {}
      }
    });

    // 1. 打开登录页（优先使用邀请链接）
    const inviteCode = CONFIG.INVITE_CODES.length > 0
      ? CONFIG.INVITE_CODES[Math.floor(Math.random() * CONFIG.INVITE_CODES.length)]
      : "";

    if (inviteCode) {
      log(`使用邀请码: ${inviteCode}`);
      log(`打开邀请链接: https://zenmux.ai/invite/${inviteCode}`);
      await page.goto(`https://zenmux.ai/invite/${inviteCode}`, {
        waitUntil: "networkidle",
        timeout: 60_000,
      });
    } else {
      log("打开 ZenMux 登录页...");
      await page.goto("https://zenmux.ai", {
        waitUntil: "networkidle",
        timeout: 60_000,
      });
    }

    // 等待页面加载完成
    await sleep(3000);

    // 点击 Sign In 按钮打开登录模态框
    log("查找 Sign In 按钮...");

    // 保存截图用于调试
    await page.screenshot({ path: "/tmp/zenmux_before_signin.png" });

    // 尝试多种方式点击 Sign In
    const signInSelectors = [
      'button:has-text("Sign In")',
      'a:has-text("Sign In")',
      'button:has-text("登录")',
      'a:has-text("登录")',
      '[class*="login"]',
      '[class*="signin"]',
    ];

    let signInClicked = false;
    for (const selector of signInSelectors) {
      try {
        const element = page.locator(selector).first();
        if (await element.isVisible({ timeout: 2000 })) {
          await element.click();
          log(`已点击: ${selector}`);
          signInClicked = true;
          await sleep(2000);
          break;
        }
      } catch (e) {}
    }

    if (!signInClicked) {
      log("未找到 Sign In 按钮");
      await page.screenshot({ path: "/tmp/zenmux_no_signin.png" });
    }

    // 登录弹窗第一步: 有 OAuth 按钮 + "Continue with Email"
    // 需要先点击 "Continue with Email" 才会显示邮箱输入框
    log("点击 Continue with Email...");
    try {
      const emailBtn = page.locator('button:has-text("Continue with Email")').first();
      if (await emailBtn.isVisible({ timeout: 5000 })) {
        await emailBtn.click();
        log("已点击 Continue with Email");
        await sleep(2500);
      } else {
        log("未找到 Continue with Email 按钮（可能已是邮箱步骤）");
      }
    } catch (e) {
      log(`点击 Continue with Email 出错: ${e.message}`);
    }

    // 2. 查找并填写邮箱
    log("查找邮箱输入框...");

    // 保存当前页面截图
    await page.screenshot({ path: "/tmp/zenmux_after_signin.png" });

    // 尝试多种选择器
    const emailSelectors = [
      'input[id="email"]',
      'input[type="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="Enter your email" i]',
      'input[name="email"]',
    ];

    let emailInput = null;
    for (const selector of emailSelectors) {
      try {
        const elements = await page.$$(selector);
        for (const el of elements) {
          const isVisible = await el.isVisible();
          if (isVisible) {
            emailInput = el;
            log(`找到邮箱输入框: ${selector}`);
            break;
          }
        }
        if (emailInput) break;
      } catch (e) {}
    }

    if (!emailInput) {
      // 截图以便调试
      await page.screenshot({ path: "/tmp/zenmux_debug.png" });
      log("找不到邮箱输入框，已截图到 /tmp/zenmux_debug.png");
      result.error = "找不到邮箱输入框";
      saveResult(email, result);
      return false;
    }

    // 清空并输入邮箱
    await emailInput.click({ clickCount: 3 });
    await emailInput.fill(email);
    log(`已输入邮箱: ${email}`);

    await sleep(1000);

    // 2.5 查找邀请码输入框并填写（如果通过邀请链接进入，可能已自动填入）
    if (inviteCode) {
      const inviteSelectors = [
        'input[placeholder*="invite" i]',
        'input[placeholder*="邀请" i]',
        'input[placeholder*="code" i]',
        'input[name*="invite" i]',
        'input[id*="invite" i]',
      ];
      let inviteInput = null;
      for (const selector of inviteSelectors) {
        try {
          const els = await page.$$(selector);
          for (const el of els) {
            if (await el.isVisible().catch(() => false)) {
              inviteInput = el;
              break;
            }
          }
          if (inviteInput) break;
        } catch (e) {}
      }
      if (inviteInput) {
        const currentVal = await inviteInput.inputValue().catch(() => "");
        if (!currentVal) {
          await inviteInput.click({ clickCount: 3 });
          await inviteInput.fill(inviteCode);
          log(`已输入邀请码: ${inviteCode}`);
        } else {
          log(`邀请码已自动填入: ${currentVal}`);
        }
        await sleep(500);
      }
    }

    // 3. 解决 Turnstile 验证码
    log("解决 Turnstile 验证码...");
    let turnstileToken = null;
    let turnstileSolved = false;

    if (CONFIG.CAPSOLVER_API_KEY) {
      // 使用 CapSolver API 解决 Turnstile
      try {
        // 方法1: 从已知的网络请求中提取 sitekey (拦截 challenges.cloudflare.com 请求)
        let sitekey = null;

        // 先检查页面上的 iframe（如果有的话）
        sitekey = await page.evaluate(() => {
          const container = document.querySelector('[data-sitekey]');
          if (container) return container.getAttribute("data-sitekey");

          const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
          if (iframe) {
            const match = iframe.src.match(/sitekey=([^&]+)/);
            if (match) return decodeURIComponent(match[1]);
          }
          return null;
        });

        // 方法2: 如果 iframe 中没找到，从页面脚本 src 中提取
        if (!sitekey) {
          const cfRequests = [];
          const requestHandler = req => {
            const url = req.url();
            if (url.includes('challenges.cloudflare.com/turnstile')) {
              cfRequests.push(url);
            }
          };
          page.on('request', requestHandler);
          await sleep(2000);
          page.off('request', requestHandler);

          for (const url of cfRequests) {
            // URL 格式: .../turnstile/f/ov2/.../{sitekey}/auto/...
            const match = url.match(/\/0x[A-Fa-f0-9]{20,}\//);
            if (match) {
              sitekey = match[0].replace(/\//g, '');
              break;
            }
          }
        }

        // 方法3: 如果还没找到，硬编码已知的 sitekey（可从网络抓包获得）
        if (!sitekey) {
          // ZenMux.ai 当前使用的 Turnstile sitekey (从网络请求中提取)
          sitekey = "0x4AAAAAAB3vWB8HhhtIcASj";
          log(`使用已知的 sitekey: ${sitekey}`);
        }

        if (sitekey) {
          log(`找到 Turnstile sitekey: ${sitekey.slice(0, 20)}...`);

          // 先检查 CapSolver 余额
          try {
            const bal = await getBalance(CONFIG.CAPSOLVER_API_KEY);
            log(`CapSolver 余额: ${bal.balance} ${bal.currency}`);
          } catch (e) {
            log(`查询余额失败: ${e.message}`);
          }

          log("正在通过 CapSolver 解决 Turnstile...");
          const solution = await solveTurnstile({
            apiKey: CONFIG.CAPSOLVER_API_KEY,
            websiteURL: page.url(),
            websiteKey: sitekey,
          });

          turnstileToken = solution.token;
          log(`✓ CapSolver 返回 token: ${turnstileToken.slice(0, 30)}...`);

          // 注入 token 到页面并通过拦截到的 turnstile callback 通知 React
          // 关键: 仅设置 input 值 + 强制启用按钮无效，React 状态不会更新；
          // 必须调用 turnstile render 时注册的 callback(token) 才能让前端真正放行
          const injected = await page.evaluate((token) => {
            const inputs = document.querySelectorAll(
              'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
            );
            for (const input of inputs) {
              input.value = token;
              input.dispatchEvent(new Event("change", { bubbles: true }));
              input.dispatchEvent(new Event("input", { bubbles: true }));
            }
            // 调用拦截到的 callback（由 addInitScript 注入的 patch 捕获）
            let cbCalled = false;
            if (typeof window.__tsCallback === "function") {
              try { window.__tsCallback(token); cbCalled = true; } catch (e) {}
            }
            return cbCalled;
          }, turnstileToken);

          if (injected) {
            turnstileSolved = true;
            log("✓ Turnstile token 已注入并通过 callback 通知前端");
          } else {
            // 备用: 直接设置 input（部分场景前端监听 input 变化）
            try {
              await page.evaluate((token) => {
                let input = document.querySelector('input[name="cf-turnstile-response"]');
                if (!input) {
                  input = document.createElement("input");
                  input.type = "hidden";
                  input.name = "cf-turnstile-response";
                  document.body.appendChild(input);
                }
                input.value = token;
              }, turnstileToken);
              turnstileSolved = true;
              log("✓ Turnstile token 已通过备用方式注入");
            } catch (e) {
              log(`备用注入失败: ${e.message}`);
            }
          }
        } else {
          log("⚠ 未找到 Turnstile sitekey，尝试回退到自动等待模式");
        }
      } catch (e) {
        log(`CapSolver 解决 Turnstile 失败: ${e.message}`);
        log("回退到自动等待模式...");
      }
    }

    // 如果 CapSolver 未配置或失败，回退到原始的自动等待逻辑
    if (!turnstileSolved) {
      if (!CONFIG.CAPSOLVER_API_KEY) {
        log("未配置 CAPSOLVER_API_KEY，使用自动等待模式");
      }

      const turnstileStart = Date.now();

      // Turnstile managed 模式通常会自动通过
      while (Date.now() - turnstileStart < 60_000) {
        const token = await page.evaluate(() => {
          const inputs = document.querySelectorAll(
            'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
          );
          for (const input of inputs) {
            if (input.value && input.value.length > 20) {
              return input.value;
            }
          }
          return null;
        });
        if (token) {
          turnstileSolved = true;
          turnstileToken = token;
          log("✓ Turnstile 自动验证完成");
          break;
        }
        const elapsed = Math.round((Date.now() - turnstileStart) / 1000);
        process.stdout.write(`\r等待 Turnstile 自动通过... ${elapsed}s`);
        await sleep(1500);
      }
      console.log();

      // 如果没自动通过，尝试点击交互式复选框
      if (!turnstileSolved) {
        log("未自动通过，尝试点击 Turnstile 复选框...");
        try {
          const widgetBox = await page.locator('iframe[src*="challenges.cloudflare.com"]').boundingBox().catch(() => null);
          if (widgetBox) {
            await page.mouse.click(widgetBox.x + 28, widgetBox.y + widgetBox.height / 2);
            log(`已点击 Turnstile 复选框位置 (${widgetBox.x + 28}, ${widgetBox.y + widgetBox.height / 2})`);
            await sleep(3000);
          }
        } catch (e) {
          log(`点击 Turnstile 出错: ${e.message}`);
        }

        const turnstileStart2 = Date.now();
        while (Date.now() - turnstileStart2 < CONFIG.TURNSTILE_TIMEOUT) {
          const token = await page.evaluate(() => {
            const inputs = document.querySelectorAll(
              'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
            );
            for (const input of inputs) {
              if (input.value && input.value.length > 20) {
                return input.value;
              }
            }
            return null;
          });
          if (token) {
            turnstileSolved = true;
            turnstileToken = token;
            log("✓ Turnstile 验证完成");
            break;
          }
          const elapsed = Math.round((Date.now() - turnstileStart2) / 1000);
          process.stdout.write(`\r等待 Turnstile... ${elapsed}s`);
          await sleep(2000);
        }
        console.log();
      }
    }

    if (!turnstileSolved) {
      log("⚠ Turnstile 验证未完成，继续尝试发送（可能 API 会拒绝）");
      await page.screenshot({ path: "/tmp/zenmux_turnstile_fail.png" });
    }

    // 等待 Send Email 按钮启用（CapSolver 注入 callback 后 React 会异步启用它）
    if (turnstileSolved) {
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        const enabled = await page.evaluate(() => {
          const send = Array.from(document.querySelectorAll("button")).filter(e => e.offsetParent).find(b => (b.textContent || "").includes("Send"));
          return send ? !send.disabled : false;
        });
        if (enabled) { log("✓ Send Email 按钮已启用"); break; }
      }
    }

    // 4. 点击发送验证码按钮
    log("查找发送验证码按钮...");

    // 邮箱步骤的提交按钮是 "Send Email"
    let sendButton = null;
    const sendSelectors = [
      'button:has-text("Send Email")',
      'button:has-text("Send")',
      'button:has-text("发送")',
      'button:has-text("Continue with Email")',
    ];
    for (const sel of sendSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          sendButton = el;
          log(`找到发送按钮: ${sel}`);
          break;
        }
      } catch (e) {}
    }

    // 备用: 遍历所有按钮，排除 OAuth 按钮
    if (!sendButton) {
      const allButtons = await page.$$("button");
      for (const btn of allButtons) {
        try {
          const visible = await btn.isVisible();
          if (!visible) continue;
          const text = ((await btn.textContent()) || "").trim().toLowerCase();
          if (!text) continue;
          if (text.includes("google") || text.includes("github")) continue;
          if (text.includes("send") || text.includes("email") || text.includes("发送")) {
            sendButton = btn;
            log(`找到发送按钮(遍历): "${text}"`);
            break;
          }
        } catch (e) {}
      }
    }

    if (!sendButton) {
      await page.screenshot({ path: "/tmp/zenmux_debug_send.png" });
      log("找不到发送按钮，已截图到 /tmp/zenmux_debug_send.png");
      result.error = "找不到发送按钮";
      saveResult(email, result);
      return false;
    }

    // 如果按钮被禁用，先尝试启用它
    const isDisabled = await sendButton.isDisabled().catch(() => false);
    if (isDisabled) {
      log("发送按钮被禁用，尝试启用...");
      await page.evaluate(() => {
        const allBtns = document.querySelectorAll('button[disabled]');
        for (const btn of allBtns) {
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('send') || text.includes('email')) {
            btn.disabled = false;
            btn.removeAttribute("disabled");
          }
        }
      });
      await sleep(500);
    }

    // 点击发送按钮
    await sendButton.click({ force: true });
    log("已点击发送验证码按钮");

    // 等待 API 响应 (code/send 返回成功才算发送)
    let sendOk = false;
    const sendDeadline = Date.now() + 20_000;
    while (Date.now() < sendDeadline) {
      await sleep(1000);
      if (codeSendResult) {
        log(`验证码发送API响应: ${JSON.stringify(codeSendResult)}`);
        if (codeSendResult && codeSendResult.success !== false && codeSendResult.code !== "INTERNAL_ERROR") {
          sendOk = true;
        }
        break;
      }
    }

    // 检查是否有错误提示
    const errorMsg = await page.evaluate(() => {
      const errorElements = document.querySelectorAll(
        '.error, .ant-message-error, [class*="error"], [class*="Error"]'
      );
      for (const el of errorElements) {
        if (el.textContent && el.textContent.trim()) {
          return el.textContent.trim();
        }
      }
      return null;
    });

    if (errorMsg) {
      log(`页面错误: ${errorMsg}`);
      result.error = errorMsg;
      saveResult(email, result);
      return false;
    }

    if (!sendOk && !codeSendResult) {
      log("⚠ 未捕获到验证码发送API响应，继续尝试获取验证码");
    }

    // 5. 从邮箱获取验证码
    log("等待邮件中的验证码...");
    let code = null;

    if (!account.isAuth0) {
      // 使用 Microsoft Graph API 直接获取验证码
      code = await fetchVerificationCodeFromGraph(email, refresh_token, client_id);

      // 如果 Graph API 失败，尝试 hotmail_helper
      if (!code) {
        log("Graph API 获取验证码失败，尝试 hotmail_helper...");
        try {
          const resp = await fetch(`${CONFIG.HOTMAIL_API_BASE}/health`);
          if (resp.ok) {
            code = await fetchVerificationCode(email, refresh_token, client_id);
          }
        } catch (e) {}
      }
    } else {
      log("账号是 Auth0 token，需要手动输入验证码");
    }

    if (!code) {
      // 手动输入验证码
      log("请检查邮箱中的验证码");
      code = await ask("请输入6位验证码: ");
    }

    if (!code || code.trim().length < 4) {
      log("无效的验证码");
      result.error = "无效的验证码";
      saveResult(email, result);
      return false;
    }

    code = code.trim();

    // 6. 输入验证码
    log(`输入验证码: ${code}`);

    // 等待验证码输入界面出现（点击 Continue 后会切换到 OTP 输入视图）
    await sleep(2000);
    await page.screenshot({ path: "/tmp/zenmux_code_input.png" });

    // 查找验证码输入框 - 优先 OTP 多框，然后单框
    let codeInput = null;
    let usedOtp = false;
    let usedOtpSingle = false;

    // 先尝试 OTP 多输入框 (每位一个框)
    const otpInputs = await page.$$('input[maxlength="1"]');
    if (otpInputs.length === 6) {
      log("找到6位OTP输入框");
      for (let i = 0; i < 6; i++) {
        await otpInputs[i].click();
        await otpInputs[i].fill(code[i]);
        await sleep(100);
      }
      usedOtp = true;
    } else {
      // ZenMux 用单个 maxlength=6 的 OTP 框 (otpNativeInput)
      // 关键: 不能用 fill()，必须用 type() 逐位输入触发 React onChange
      const otpSingle = await page.$('input.otpNativeInput-LCOdN2Gu, input[maxlength="6"]');
      if (otpSingle && await otpSingle.isVisible().catch(() => false)) {
        log("找到单框OTP输入框");
        await otpSingle.click();
        await otpSingle.type(code, { delay: 100 });
        usedOtpSingle = true;
      } else {
        // 普通单框
        const codeInputSelectors = [
          'input[placeholder*="code" i]',
          'input[placeholder*="验证码" i]',
          'input[name="code"]',
          'input[id*="code" i]',
          'input.otp-input',
          'input[class*="otp"]',
          'input[class*="code"]',
          'input[type="text"]',
          'input.ant-input',
        ];
        for (const selector of codeInputSelectors) {
          try {
            const els = await page.$$(selector);
            for (const el of els) {
              if (await el.isVisible().catch(() => false)) {
                codeInput = el;
                log(`找到验证码输入框: ${selector}`);
                break;
              }
            }
            if (codeInput) break;
          } catch (e) {}
        }

        if (codeInput) {
          await codeInput.click({ clickCount: 3 });
          await codeInput.type(code, { delay: 100 });
        }
      }
    }

    if (!codeInput && !usedOtp && !usedOtpSingle) {
      await page.screenshot({ path: "/tmp/zenmux_debug_code.png" });
      log("找不到验证码输入框，已截图到 /tmp/zenmux_debug_code.png");
      result.error = "找不到验证码输入框";
      saveResult(email, result);
      return false;
    }

    log("已输入验证码，等待登录完成...");

    // 单框可能需要按回车提交
    if (!usedOtp && !usedOtpSingle && codeInput) {
      try {
        await codeInput.press("Enter").catch(() => {});
      } catch (e) {}
    }

    // 等待页面跳转或登录成功
    let loginOk = false;
    const loginDeadline = Date.now() + 30_000;
    while (Date.now() < loginDeadline) {
      await sleep(2000);
      const url = page.url();
      // 登录成功的标志：URL 离开登录页且不是 Google/GitHub OAuth 域
      const onOAuth = url.includes("accounts.google.com") || url.includes("github.com/login");
      if (!onOAuth && (url.includes("/chat") || url.includes("/settings") || url.includes("/verify") || (url.includes("zenmux.ai") && !url.includes("/sign") && !url.includes("/login")))) {
        loginOk = true;
        break;
      }
      // 如果跳转到了 Google/GitHub OAuth，说明点错了按钮，停止
      if (onOAuth) {
        log("⚠ 跳转到了第三方 OAuth，点错按钮了");
        break;
      }
    }

    // 检查是否登录成功
    const currentUrl = page.url();
    log(`当前页面: ${currentUrl}`);

    if (loginOk || (!currentUrl.includes("accounts.google.com") && !currentUrl.includes("github.com") && !currentUrl.includes("/sign"))) {
      // 检查是否有 needVerify
      if (currentUrl.includes("/verify")) {
        log("需要额外验证，尝试完成...");
        // 尝试点击验证按钮
        try {
          const verifyButton = page.locator('button:has-text("Verify"), button:has-text("验证")');
          if (await verifyButton.isVisible({ timeout: 5000 })) {
            await verifyButton.click();
            await sleep(3000);
          }
        } catch (e) {}
      }

      // 获取 cookies
      const cookies = await context.cookies();
      const sessionId = cookies.find(
        (c) => c.name === "sessionId" || c.name === "token"
      );

      log(`✅ 注册成功: ${email}`);
      if (sessionId) {
        log(`Session ID: ${sessionId.value}`);
      } else {
        log("⚠ 未找到 sessionId cookie");
      }

      // 保存登录状态
      const storageState = await context.storageState();
      const statePath = path.join(
        __dirname,
        "zenmux_sessions",
        `${email.replace(/[@.]/g, "_")}.json`
      );
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(storageState, null, 2));
      log(`登录状态已保存: ${statePath}`);

      // 只保存成功的结果
      result.success = true;
      result.cookies = cookies;
      result.sessionId = sessionId ? sessionId.value : null;
      result.extra = {
        statePath,
        currentUrl: page.url(),
      };
      saveResult(email, result);

      return true;
    }

    log("注册流程未完成");
    await page.screenshot({ path: "/tmp/zenmux_debug_final.png" });
    result.error = "注册流程未完成";
    saveResult(email, result);
    return false;
  } catch (e) {
    log(`注册出错: ${e.message}`);
    result.error = e.message;
    saveResult(email, result);
    return false;
  } finally {
    if (context) {
      // 保存最终截图
      try {
        const pages = context.pages();
        if (pages.length > 0) {
          await pages[0].screenshot({
            path: "/tmp/zenmux_final.png",
            fullPage: true,
          });
        }
      } catch (e) {}
    }
    if (browser) {
      await browser.close();
    }
  }
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const args = process.argv.slice(2);

  log("ZenMux.ai 注册机 v1.1 (CapSolver 集成)");
  log(`${"=".repeat(60)}`);

  // 检查 CapSolver 配置
  if (CONFIG.CAPSOLVER_API_KEY) {
    log(`✓ CapSolver API Key 已配置 (${CONFIG.CAPSOLVER_API_KEY.slice(0, 8)}...)`);
    try {
      const bal = await getBalance(CONFIG.CAPSOLVER_API_KEY);
      log(`  余额: ${bal.balance} ${bal.currency}`);
    } catch (e) {
      log(`  ⚠ 查询余额失败: ${e.message}`);
    }
  } else {
    log("⚠ 未配置 CAPSOLVER_API_KEY，将使用自动等待模式解决 Turnstile");
    log("  配置方式: export CAPSOLVER_API_KEY=your_key 或 --capsolver your_key");
  }

  // 检查 hotmail_helper 是否运行
  try {
    const resp = await fetch(`${CONFIG.HOTMAIL_API_BASE}/health`);
    if (resp.ok) {
      log("✓ hotmail_helper API 已运行");
    } else {
      log("⚠ hotmail_helper API 响应异常");
    }
  } catch (e) {
    log("✗ hotmail_helper API 未运行");
    const helperPath = path.join(__dirname, "hotmail_helper(1).py");
    log(`  请先启动: python "${helperPath}"`);
    log("  或者手动输入验证码模式将继续");
  }

  // 解析参数
  let targetEmail = null;
  let batchMode = false;
  let maxCount = Infinity;
  let showSummaryOnly = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--email" && args[i + 1]) {
      targetEmail = args[++i];
    } else if (args[i] === "--batch") {
      batchMode = true;
    } else if (args[i] === "--count" && args[i + 1]) {
      maxCount = parseInt(args[++i]);
    } else if (args[i] === "--invite" && args[i + 1]) {
      CONFIG.INVITE_CODE = args[++i];
    } else if (args[i] === "--headed") {
      CONFIG.HEADLESS = false;
    } else if (args[i] === "--capsolver" && args[i + 1]) {
      CONFIG.CAPSOLVER_API_KEY = args[++i];
    } else if (args[i] === "--summary") {
      showSummaryOnly = true;
    }
  }

  // 显示汇总
  if (showSummaryOnly) {
    showSummary();
    process.exit(0);
  }

  if (batchMode) {
    // 批量模式
    const accounts = loadAccounts();
    log(`找到 ${accounts.length} 个可用账号`);

    if (accounts.length === 0) {
      log("没有可用账号");
      process.exit(1);
    }

    const toProcess = accounts.slice(0, maxCount);
    log(`将处理 ${toProcess.length} 个账号`);

    const results = { success: 0, failed: 0 };

    for (const account of toProcess) {
      const ok = await registerAccount(account);
      if (ok) {
        results.success++;
      } else {
        results.failed++;
      }
      log(`进度: 成功 ${results.success}, 失败 ${results.failed}`);
      await sleep(5000); // 间隔
    }

    log(`\n${"=".repeat(60)}`);
    log(`批量注册完成: 成功 ${results.success}, 失败 ${results.failed}`);

    // 显示汇总
    showSummary();
  } else if (targetEmail) {
    // 指定邮箱模式
    const accounts = loadAccounts();
    const account = accounts.find(
      (a) => a.email.toLowerCase() === targetEmail.toLowerCase()
    );

    if (account) {
      await registerAccount(account);
    } else {
      // 手动输入 refresh_token
      log(`未找到 ${targetEmail} 的配置`);
      const refreshToken = await ask("请输入 refresh_token: ");
      const clientId = await ask("请输入 client_id: ");

      if (refreshToken && clientId) {
        await registerAccount({
          email: targetEmail,
          refresh_token: refreshToken,
          client_id: clientId,
        });
      }
    }
  } else {
    // 交互模式
    const email = await ask("请输入邮箱地址: ");
    if (!email) {
      log("未输入邮箱，退出");
      process.exit(0);
    }

    // 查找配置
    const accounts = loadAccounts();
    const account = accounts.find(
      (a) => a.email.toLowerCase() === email.toLowerCase()
    );

    if (account) {
      await registerAccount(account);
    } else {
      const refreshToken = await ask("请输入 refresh_token: ");
      const clientId = await ask("请输入 client_id: ");

      if (refreshToken && clientId) {
        await registerAccount({
          email,
          refresh_token: refreshToken,
          client_id: clientId,
        });
      } else {
        log("缺少必要信息，退出");
      }
    }
  }
}

main().catch((e) => {
  log(`致命错误: ${e.message}`);
  process.exit(1);
});
