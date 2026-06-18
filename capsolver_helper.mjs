/**
 * CapSolver 验证码求解器
 *
 * 通过 API 调用 capsolver.com 解决各类验证码，无需 GUI。
 * 支持: Cloudflare Turnstile, reCAPTCHA, hCaptcha, FunCaptcha, ImageToText
 *
 * 用法:
 *   import { solveTurnstile, solveRecaptchaV2, solveImageToText } from "./capsolver_helper.mjs";
 *
 *   const token = await solveTurnstile({
 *     apiKey: "YOUR_CAPSOLVER_API_KEY",
 *     websiteURL: "https://zenmux.ai",
 *     websiteKey: "0x4AAAAAA...",
 *   });
 */

const CAPSOLVER_API_BASE = "https://api.capsolver.com";

// ============================================================
// 通用: 创建任务 + 轮询结果
// ============================================================

/**
 * 创建 CapSolver 任务并等待结果
 * @param {string} apiKey - CapSolver API Key
 * @param {object} task - 任务对象 (含 type 和其他参数)
 * @param {number} [pollInterval=1500] - 轮询间隔 (ms)
 * @param {number} [timeout=120000] - 超时 (ms)
 * @returns {Promise<object>} - solution 对象
 */
async function createTaskAndPoll(apiKey, task, pollInterval = 1500, timeout = 120_000) {
  // 1. 创建任务
  const createResp = await fetch(`${CAPSOLVER_API_BASE}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task,
    }),
  });

  if (!createResp.ok) {
    throw new Error(`CapSolver createTask HTTP error: ${createResp.status}`);
  }

  const createData = await createResp.json();

  if (createData.errorId !== 0) {
    throw new Error(`CapSolver createTask error: [${createData.errorCode}] ${createData.errorDescription}`);
  }

  const taskId = createData.taskId;
  if (!taskId) {
    throw new Error("CapSolver createTask: no taskId returned");
  }

  // 2. 轮询结果
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const resultResp = await fetch(`${CAPSOLVER_API_BASE}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        taskId,
      }),
    });

    if (!resultResp.ok) {
      throw new Error(`CapSolver getTaskResult HTTP error: ${resultResp.status}`);
    }

    const resultData = await resultResp.json();

    if (resultData.errorId !== 0) {
      throw new Error(`CapSolver getTaskResult error: [${resultData.errorCode}] ${resultData.errorDescription}`);
    }

    if (resultData.status === "ready") {
      return resultData.solution;
    }

    // status === "processing" → 继续轮询
  }

  throw new Error(`CapSolver polling timeout after ${timeout}ms`);
}

// ============================================================
// Cloudflare Turnstile
// ============================================================

/**
 * 解决 Cloudflare Turnstile 验证码
 *
 * @param {object} options
 * @param {string} options.apiKey - CapSolver API Key
 * @param {string} options.websiteURL - 页面 URL
 * @param {string} options.websiteKey - Turnstile sitekey (从 data-sitekey 属性获取)
 * @param {string} [options.action] - data-action 属性值 (可选)
 * @param {string} [options.cdata] - data-cdata 属性值 (可选)
 * @param {number} [options.timeout] - 超时毫秒数
 * @returns {Promise<{token: string, userAgent: string}>} Turnstile token 和 userAgent
 */
export async function solveTurnstile({ apiKey, websiteURL, websiteKey, action, cdata, timeout }) {
  if (!apiKey) throw new Error("CapSolver API key is required");
  if (!websiteURL) throw new Error("websiteURL is required");
  if (!websiteKey) throw new Error("websiteKey (Turnstile sitekey) is required");

  const task = {
    type: "AntiTurnstileTaskProxyLess",
    websiteURL,
    websiteKey,
  };

  if (action) task.metadata = { ...(task.metadata || {}), action };
  if (cdata) task.metadata = { ...(task.metadata || {}), cdata };

  const solution = await createTaskAndPoll(apiKey, task, 1500, timeout || 120_000);

  if (!solution.token) {
    throw new Error("CapSolver returned no token for Turnstile");
  }

  return {
    token: solution.token,
    userAgent: solution.userAgent || null,
  };
}

// ============================================================
// reCAPTCHA v2
// ============================================================

/**
 * 解决 reCAPTCHA v2
 *
 * @param {object} options
 * @param {string} options.apiKey - CapSolver API Key
 * @param {string} options.websiteURL - 页面 URL
 * @param {string} options.websiteKey - reCAPTCHA sitekey
 * @param {boolean} [options.isInvisible=false] - 是否是不可见 reCAPTCHA
 * @param {string} [options.action] - pageAction (可选)
 * @param {number} [options.timeout] - 超时毫秒数
 * @returns {Promise<{token: string}>} gRecaptchaResponse token
 */
export async function solveRecaptchaV2({ apiKey, websiteURL, websiteKey, isInvisible, action, timeout }) {
  if (!apiKey) throw new Error("CapSolver API key is required");
  if (!websiteURL) throw new Error("websiteURL is required");
  if (!websiteKey) throw new Error("websiteKey is required");

  const task = {
    type: "ReCaptchaV2TaskProxyLess",
    websiteURL,
    websiteKey,
  };

  if (isInvisible) task.isInvisible = true;
  if (action) task.pageAction = action;

  const solution = await createTaskAndPoll(apiKey, task, 1500, timeout || 120_000);

  if (!solution.gRecaptchaResponse) {
    throw new Error("CapSolver returned no token for reCAPTCHA v2");
  }

  return { token: solution.gRecaptchaResponse };
}

// ============================================================
// reCAPTCHA v3
// ============================================================

/**
 * 解决 reCAPTCHA v3
 */
export async function solveRecaptchaV3({ apiKey, websiteURL, websiteKey, pageAction, minScore = 0.7, timeout }) {
  if (!apiKey) throw new Error("CapSolver API key is required");

  const task = {
    type: "ReCaptchaV3TaskProxyLess",
    websiteURL,
    websiteKey,
    pageAction: pageAction || "verify",
    minScore,
  };

  const solution = await createTaskAndPoll(apiKey, task, 1500, timeout || 120_000);
  return { token: solution.gRecaptchaResponse };
}

// ============================================================
// hCaptcha
// ============================================================

/**
 * 解决 hCaptcha
 */
export async function solveHCaptcha({ apiKey, websiteURL, websiteKey, isInvisible, timeout }) {
  if (!apiKey) throw new Error("CapSolver API key is required");

  const task = {
    type: "HCaptchaTaskProxyLess",
    websiteURL,
    websiteKey,
  };

  if (isInvisible) task.isInvisible = true;

  const solution = await createTaskAndPoll(apiKey, task, 1500, timeout || 120_000);
  return { token: solution.gRecaptchaResponse };
}

// ============================================================
// FunCaptcha (Arkose Labs)
// ============================================================

/**
 * 解决 FunCaptcha
 */
export async function solveFunCaptcha({ apiKey, websiteURL, websitePublicKey, timeout }) {
  if (!apiKey) throw new Error("CapSolver API key is required");

  const task = {
    type: "FunCaptchaTaskProxyLess",
    websiteURL,
    websitePublicKey,
  };

  const solution = await createTaskAndPoll(apiKey, task, 1500, timeout || 120_000);
  return { token: solution.token };
}

// ============================================================
// Image-to-Text (OCR) — 同步返回，无需轮询
// ============================================================

/**
 * 图片文字识别 (OCR)
 * 注意: 此接口同步返回结果，不需要轮询
 *
 * @param {object} options
 * @param {string} options.apiKey - CapSolver API Key
 * @param {string} options.body - Base64 编码的图片 (不含前缀)
 * @param {string} [options.module="common"] - 模块: "common" 或 "number"
 * @returns {Promise<{text: string}>} 识别出的文字
 */
export async function solveImageToText({ apiKey, body, module = "common" }) {
  if (!apiKey) throw new Error("CapSolver API key is required");
  if (!body) throw new Error("body (base64 image) is required");

  const resp = await fetch(`${CAPSOLVER_API_BASE}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: "ImageToTextTask",
        body,
        module,
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`CapSolver ImageToText HTTP error: ${resp.status}`);
  }

  const data = await resp.json();

  if (data.errorId !== 0) {
    throw new Error(`CapSolver ImageToText error: [${data.errorCode}] ${data.errorDescription}`);
  }

  return { text: data.solution?.text };
}

// ============================================================
// 查询余额
// ============================================================

/**
 * 查询 CapSolver 账户余额
 * @param {string} apiKey
 * @returns {Promise<{balance: number, currency: string}>}
 */
export async function getBalance(apiKey) {
  if (!apiKey) throw new Error("CapSolver API key is required");

  const resp = await fetch(`${CAPSOLVER_API_BASE}/getBalance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey }),
  });

  if (!resp.ok) {
    throw new Error(`CapSolver getBalance HTTP error: ${resp.status}`);
  }

  const data = await resp.json();

  if (data.errorId !== 0) {
    throw new Error(`CapSolver getBalance error: [${data.errorCode}] ${data.errorDescription}`);
  }

  return { balance: data.balance, currency: data.currency || "USD" };
}
