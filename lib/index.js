/**
 * dsh-always-skills —— 宿主侧常驻 Skill 自动加载引擎（支持按当前模型精准触发）
 *
 * 核心能力：
 *   1. 将用户勾选的常驻 Skill 清单与生效模型列表持久化在 ~/.dsh/always-skills.json（实时保存、免重启生效）；
 *   2. 监听 agent/pre-step 瀑布：
 *      - 先检测本次会话当前生效的模型（modelSelection / model/selection 最新事件 / requestHeader / agent.options / agentDefaultModel）；
 *      - 若配置了「仅指定模型生效（targetModels 非空）」，只有当前模型命中勾选清单时才注入；留空则全部模型均生效；
 *      - 按每轮新对话（every-turn）或每一步（every-step）将所选 Skill 完整正文以标准 <skill_content> 格式注入上下文；
 *   3. 提供同源 HTTP 接口（/dsh-always-skills/api/state 与 /dsh-always-skills/api/config），
 *      同时返回本机全部可选 Skill 和本机全部可用模型清单，供前端一键勾选。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ── 用户可修改的顶部配置常量 ──────────────────────────────────────────
/** 插件 HTTP 接口路径前缀 */
const 接口前缀 = "/dsh-always-skills/api/";
/** 持久化配置文件名（位于 ~/.dsh/ 下） */
const 配置文件名 = "always-skills.json";
/** 单次最多允许勾选的常驻 Skill 数量上限 */
const 最大常驻数量 = 30;
/** 单次最多允许指定的生效模型数量上限 */
const 最大模型数量 = 80;

export const name = "dsh-always-skills";
export const inject = [];
export const Config = {
  "~standard": {
    version: 1,
    vendor: name,
    validate: (v) => ({ value: v && typeof v === "object" ? v : {} }),
  },
};

function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function escapeAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeText(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 生成与 DSH 官方 tool-skill 完全一致的 <skill_content> 块 */
function renderSkillBlock(skill) {
  const base = skill.resourceBase;
  let resourceHint;
  if (!base) {
    resourceHint = [
      `Resources for this skill are managed by provider "${escapeText(skill.provider || "local")}".`,
      "Load referenced resources only as needed.",
    ];
  } else if (base.kind === "directory") {
    resourceHint = [
      `Base directory for this skill: ${escapeText(base.path)}`,
      "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.",
    ];
  } else if (base.kind === "url") {
    resourceHint = [
      `Base URL for this skill: ${escapeText(base.url)}`,
      "Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.",
    ];
  } else {
    resourceHint = [
      `Resources for this skill: ${escapeText(base.description || "")}`,
      "Load referenced resources only as needed.",
    ];
  }
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    "<skill_resources>",
    ...resourceHint,
    "</skill_resources>",
    "",
    "<skill_instructions>",
    String(skill.content ?? ""),
    "</skill_instructions>",
    "</skill_content>",
  ].join("\n");
}

/** 解析 SKILL.md 头部 YAML frontmatter 中的 name 与 description（文件系统兜底扫描） */
function parseSkillFrontmatter(filePath, fallbackName) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    const fm = m ? m[1] : "";
    const body = m ? m[2] : raw;
    const nameM = fm.match(/^name:\s*(.+)$/m);
    const descM = fm.match(/^description:\s*(.+)$/m);
    const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");
    return {
      name: clean(nameM?.[1]) || fallbackName,
      description: clean(descM?.[1]) || "",
      content: body.trim(),
      path: filePath,
    };
  } catch {
    return null;
  }
}

/** 兜底直接扫描 ~/.dsh/skills 与 ~/.agents/skills 目录 */
function scanDiskSkills(dshHome) {
  const map = new Map();
  const roots = [
    path.join(dshHome, "skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".codex", "skills"),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const md = path.join(root, ent.name, "SKILL.md");
      if (!fs.existsSync(md)) continue;
      const parsed = parseSkillFrontmatter(md, ent.name);
      if (parsed && parsed.name && !map.has(parsed.name)) {
        map.set(parsed.name, {
          name: parsed.name,
          description: parsed.description,
          source: "user-dsh",
          provider: "filesystem",
          path: md,
          resourceBase: { kind: "directory", path: path.dirname(md) },
          content: parsed.content,
        });
      }
    }
  }
  return map;
}

/** 兜底从本机 cordis.patch.yml 解析可用模型目录 */
function scanPatchModels(dshHome) {
  const out = [];
  try {
    const patchPath = path.join(dshHome, "profiles", "desktop", "cordis.patch.yml");
    if (!fs.existsSync(patchPath)) return out;
    const txt = fs.readFileSync(patchPath, "utf8");
    const llmBlock = txt.split(/^- id:\s*llm-pi-ai/m)[1]?.split(/^- id:/m)[0] || "";
    const provSec = llmBlock.split(/^\s{4}providers:\s*$/m)[1] || "";
    let curProv = null, curProvName = "", curModel = null;
    const flush = () => {
      if (curProv && curModel && curModel.model) {
        out.push({
          key: curProv + "::" + curModel.model,
          provider: curProv,
          providerName: curProvName || curProv,
          model: curModel.model,
          name: curModel.name || curModel.model,
        });
      }
      curModel = null;
    };
    for (const line of provSec.split(/\r?\n/)) {
      if (/^\s{6}([a-zA-Z0-9._-]+):\s*$/.test(line)) { flush(); curProv = line.trim().slice(0, -1); curProvName = curProv; continue; }
      if (!curProv) continue;
      const dn = line.match(/^\s{8}displayName:\s*(.+)$/);
      if (dn) { curProvName = dn[1].trim().replace(/^["']|["']$/g, ""); continue; }
      const mid = line.match(/^\s{10}-\s+id:\s*(.+)$/);
      if (mid) { flush(); curModel = { model: mid[1].trim().replace(/^["']|["']$/g, ""), name: "" }; continue; }
      if (curModel) {
        const mn = line.match(/^\s{12}name:\s*(.+)$/);
        if (mn) { curModel.name = mn[1].trim().replace(/^["']|["']$/g, ""); continue; }
      }
    }
    flush();
  } catch {}
  return out;
}

function sendJson(res, status, obj) {
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(obj));
  } catch {}
}

function readJsonBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("body too large"), { status: 413 })); try { req.destroy(); } catch {} return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error("body must be JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

export function apply(ctx) {
  const dshHome = resolveDshHome();
  const cfgPath = path.join(dshHome, 配置文件名);

  /** 规范化并读取持久化配置 */
  function normalizeState(raw) {
    const enabled = raw && typeof raw.enabled === "boolean" ? raw.enabled : true;
    const mode = raw && raw.mode === "every-step" ? "every-step" : "every-turn";
    const includeSubagents = Boolean(raw && raw.includeSubagents === true);
    const dedup = (arr, cap) => {
      const seen = new Set();
      const res = [];
      for (const s of (Array.isArray(arr) ? arr : [])) {
        const n = String(s || "").trim();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        res.push(n);
        if (res.length >= cap) break;
      }
      return res;
    };
    const skills = dedup(raw?.skills, 最大常驻数量);
    // targetModels: 为空数组 [] 表示对【所有模型】生效；非空数组（如 ["xiaoxi::xiaoxi/deepseek-coding"]）表示仅当当前模型命中时生效
    const targetModels = dedup(raw?.targetModels, 最大模型数量);
    return { enabled, mode, includeSubagents, skills, targetModels, updatedAt: Number(raw?.updatedAt) || 0 };
  }

  function readState() {
    try {
      if (!fs.existsSync(cfgPath)) return normalizeState({});
      return normalizeState(JSON.parse(fs.readFileSync(cfgPath, "utf8")));
    } catch {
      return normalizeState({});
    }
  }

  function writeState(next) {
    const clean = normalizeState({ ...next, updatedAt: Date.now() });
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    const tmp = cfgPath + ".tmp-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, cfgPath);
    return clean;
  }

  /** 收集当前全部可选 Skill */
  async function listAvailableSkills(cwd, signal) {
    const merged = new Map();
    let skillsSvc = null;
    try { skillsSvc = ctx.get?.("skills") ?? ctx.skills; } catch {}
    if (skillsSvc && typeof skillsSvc.list === "function") {
      try {
        const list = await skillsSvc.list({ cwd: cwd || process.cwd(), ...(signal ? { signal } : {}) });
        for (const item of (list || [])) {
          if (!item || !item.name) continue;
          merged.set(item.name, {
            name: item.name,
            description: String(item.description || "").trim(),
            source: String(item.source || "builtin"),
            provider: String(item.provider || ""),
            path: item.path || "",
          });
        }
      } catch {}
    }
    for (const [k, v] of scanDiskSkills(dshHome)) {
      if (!merged.has(k)) {
        merged.set(k, {
          name: v.name,
          description: v.description,
          source: v.source,
          provider: v.provider,
          path: v.path,
        });
      }
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 收集当前全部可用模型（优先走 ctx.llm，兜底解析 cordis.patch.yml） */
  async function listAvailableModels() {
    let llmSvc = null;
    let defSvc = null;
    try { llmSvc = ctx.get?.("llm") ?? ctx.llm; } catch {}
    try { defSvc = ctx.get?.("agentDefaultModel") ?? ctx.agentDefaultModel; } catch {}

    let defaultKey = "";
    try {
      const sel = defSvc?.currentSelection?.();
      if (sel && sel.provider && sel.model) defaultKey = sel.provider + "::" + sel.model;
    } catch {}

    const out = [];
    const seen = new Set();
    if (llmSvc && typeof llmSvc.listProviders === "function" && typeof llmSvc.listModels === "function") {
      try {
        for (const p of (llmSvc.listProviders() || [])) {
          try {
            const list = await llmSvc.listModels(p.id);
            for (const m of (list || [])) {
              const key = p.id + "::" + m.id;
              if (seen.has(key)) continue;
              seen.add(key);
              out.push({
                key,
                provider: String(p.id),
                providerName: String(p.name || p.id),
                model: String(m.id),
                name: String(m.name || m.id),
              });
            }
          } catch {}
        }
      } catch {}
    }
    if (out.length === 0) {
      for (const m of scanPatchModels(dshHome)) {
        if (seen.has(m.key)) continue;
        seen.add(m.key);
        out.push(m);
      }
    }
    return { models: out, defaultKey };
  }

  /** 精确解析当前会话本次即将使用的模型 { provider, model } */
  function resolveActiveModel(payload) {
    // 1. 优先读取 agent/pre-step payload 自带的 modelSelection（如有）
    const ms = payload?.modelSelection;
    if (ms && ms.provider && ms.model) return { provider: String(ms.provider), model: String(ms.model) };

    const agent = payload?.agent;
    const session = agent?.session;
    // 2. 读取会话事件流中最新一条 model/selection（反映用户刚刚在下拉框切换的模型）
    if (session && typeof session.snapshotEvents === "function") {
      try {
        const events = session.snapshotEvents() || [];
        for (let i = events.length - 1; i >= 0; i--) {
          const ev = events[i];
          if (ev?.type === "model/selection" && ev.data?.provider && ev.data?.model) {
            return { provider: String(ev.data.provider), model: String(ev.data.model) };
          }
        }
      } catch {}
    }
    // 3. 回退读取上次请求的 requestHeader.config
    if (session && typeof session.requestHeader === "function") {
      try {
        const hdr = session.requestHeader();
        if (hdr?.config?.provider && hdr?.config?.model) {
          return { provider: String(hdr.config.provider), model: String(hdr.config.model) };
        }
      } catch {}
    }
    // 4. 回退读取 agent.options（如子智能体显式指定的 provider/model）
    if (agent?.options?.provider && agent?.options?.model) {
      return { provider: String(agent.options.provider), model: String(agent.options.model) };
    }
    // 5. 最后回退读取全局默认模型
    try {
      const defSvc = ctx.get?.("agentDefaultModel") ?? ctx.agentDefaultModel;
      const sel = defSvc?.currentSelection?.();
      if (sel && sel.provider && sel.model) return { provider: String(sel.provider), model: String(sel.model) };
    } catch {}
    return null;
  }

  /** 检查当前模型是否命中 targetModels 白名单（空列表 = 所有模型均命中） */
  function matchesTargetModels(targetModels, activeModel) {
    if (!Array.isArray(targetModels) || targetModels.length === 0) return true;
    if (!activeModel || !activeModel.provider || !activeModel.model) return false;
    const fullKey = activeModel.provider + "::" + activeModel.model;
    const slashKey = activeModel.provider + "/" + activeModel.model;
    return targetModels.includes(fullKey) || targetModels.includes(slashKey) || targetModels.includes(activeModel.model);
  }

  /** 根据名称解析完整 Skill 正文 */
  async function resolveSkillDef(skillName, agent, signal) {
    let skillsSvc = null;
    let wdSvc = null;
    try { skillsSvc = ctx.get?.("skills") ?? ctx.skills; } catch {}
    try { wdSvc = ctx.get?.("workingDirectory") ?? ctx.workingDirectory; } catch {}
    let cwd = process.cwd();
    if (wdSvc && typeof wdSvc.ensure === "function" && agent) {
      try { cwd = await wdSvc.ensure(agent, signal); } catch {}
    }
    if (skillsSvc && typeof skillsSvc.get === "function") {
      try {
        const def = await skillsSvc.get(skillName, { cwd, ...(signal ? { signal } : {}), ...(agent ? { scope: agent } : {}) });
        if (def && def.content) return def;
      } catch {}
    }
    return scanDiskSkills(dshHome).get(skillName) || null;
  }

  // ── 核心钩子：按模型命中条件，每次对话自动注入所有已选常驻 Skill ───────
  function isHumanUserMessage(m) {
    if (!m || typeof m !== "object") return false;
    const kind = m.source?.kind;
    return kind === "user" || kind === "steering";
  }

  const lastInjectedBySession = new Map();

  if (typeof ctx?.on === "function") {
    ctx.on("agent/pre-step", async (payload, next) => {
      const decision = await next();
      if (!decision || decision.kind === "reject") return decision;
      try {
        const { agent, messages, signal } = payload || {};
        const state = readState();
        if (!state.enabled || state.skills.length === 0) return decision;

        const isSubagent = Boolean(agent?.session?.header?.subagent || agent?.subagent);
        if (isSubagent && !state.includeSubagents) return decision;

        // 按当前生效模型过滤：若勾选了指定模型，则仅在当前模型命中时加载常驻 Skill
        const activeModel = resolveActiveModel(payload);
        if (!matchesTargetModels(state.targetModels, activeModel)) return decision;

        const claimed = Array.isArray(messages) ? messages : [];
        const humanMsgs = claimed.filter(isHumanUserMessage);
        const sid = String(agent?.session?.header?.id || "default");

        if (state.mode === "every-turn") {
          if (humanMsgs.length === 0) return decision;
          const marker = humanMsgs.map((m) => String(m.id || "")).join(",") + "|" + state.updatedAt + "|" + (activeModel ? activeModel.provider + "::" + activeModel.model : "");
          if (lastInjectedBySession.get(sid) === marker) return decision;
          lastInjectedBySession.set(sid, marker);
          if (lastInjectedBySession.size > 200) {
            const firstKey = lastInjectedBySession.keys().next().value;
            if (firstKey !== undefined) lastInjectedBySession.delete(firstKey);
          }
        }

        const existingList = Array.isArray(decision.messages) ? decision.messages : [];
        const alreadyInjectedNames = new Set();
        for (const m of existingList) {
          if (m?.source?.kind === "skill-invocation" && typeof m.source.name === "string") {
            alreadyInjectedNames.add(m.source.name);
          }
        }

        const injections = [];
        for (const skillName of state.skills) {
          if (alreadyInjectedNames.has(skillName)) continue;
          signal?.throwIfAborted?.();
          const def = await resolveSkillDef(skillName, agent, signal);
          if (!def) continue;
          injections.push({
            id: randomUUID(),
            role: "user",
            content: [{ type: "text", text: renderSkillBlock(def) }],
            source: {
              kind: "skill-invocation",
              name: def.name,
              form: "instructions",
              alwaysSkills: true,
              ...(activeModel ? { triggeredByModel: activeModel.provider + "/" + activeModel.model } : {}),
            },
          });
        }
        if (injections.length === 0) return decision;
        return { ...decision, messages: [...existingList, ...injections] };
      } catch (err) {
        ctx.logger?.warn?.("dsh-always-skills pre-step skipped: " + String(err?.message || err));
        return decision;
      }
    });
  }

  // ── 同源 HTTP API 路由 ───────────────────────────────────────────────
  function installRoutes(scope) {
    const disposers = [];
    const gate = (handler, method) => async (req, res) => {
      let connection;
      try { connection = scope.get?.("connection") ?? scope.connection; } catch {}
      if (!connection || typeof connection.requestRejection !== "function") {
        return sendJson(res, 503, { ok: false, error: "host auth service unavailable" });
      }
      let rej;
      try { rej = connection.requestRejection(req); } catch { rej = 403; }
      if (rej !== undefined) return sendJson(res, rej, { ok: false, error: rej === 403 ? "not same-origin" : "browser session required" });
      if (req.method !== method) return sendJson(res, 405, { ok: false, error: "method not allowed" });
      try {
        await handler(req, res, new URL(req.url, "http://x").searchParams);
      } catch (e) {
        sendJson(res, e?.status || 500, { ok: false, error: String(e?.message || e) });
      }
    };
    const route = (sub, method, handler) => {
      const ws = scope.get?.("webServer") ?? scope.webServer;
      if (!ws || typeof ws.register !== "function") return;
      try {
        const off = ws.register({ kind: "exact", path: 接口前缀 + sub, handler: gate(handler, method) });
        if (typeof off === "function") disposers.push(off);
      } catch (e) {
        ctx.logger?.warn?.("dsh-always-skills route " + sub + " skipped: " + String(e?.message || e));
      }
    };

    route("state", "GET", async (_req, res, qs) => {
      const cwd = qs.get("cwd") || process.cwd();
      const [state, available, modelSnap] = await Promise.all([
        Promise.resolve(readState()),
        listAvailableSkills(cwd),
        listAvailableModels(),
      ]);
      sendJson(res, 200, {
        ok: true,
        state,
        available,
        models: modelSnap.models,
        defaultModelKey: modelSnap.defaultKey,
        configPath: cfgPath,
      });
    });

    route("config", "POST", async (req, res) => {
      const body = await readJsonBody(req);
      const cur = readState();
      const next = writeState({
        enabled: typeof body.enabled === "boolean" ? body.enabled : cur.enabled,
        mode: body.mode === "every-step" || body.mode === "every-turn" ? body.mode : cur.mode,
        includeSubagents: typeof body.includeSubagents === "boolean" ? body.includeSubagents : cur.includeSubagents,
        skills: Array.isArray(body.skills) ? body.skills : cur.skills,
        targetModels: Array.isArray(body.targetModels) ? body.targetModels : cur.targetModels,
      });
      sendJson(res, 200, { ok: true, state: next, configPath: cfgPath });
    });

    /** 实时触发 DSH SkillRegistry 缓存失效与 skills/change 广播，让新保存的 Skill 毫秒级热生效 */
    function invalidateSkillRegistry() {
      try {
        const rawSvc = ctx.get?.("skills") ?? ctx.skills;
        const CORDIS_ORIG = Symbol.for("cordis.original");
        let target = rawSvc;
        while (target && typeof target === "object" && target[CORDIS_ORIG] !== undefined) {
          target = target[CORDIS_ORIG];
        }
        if (target && typeof target === "object") {
          if (typeof target.revision === "number") target.revision += 1;
          if (target.collectCache && typeof target.collectCache.clear === "function") target.collectCache.clear();
        }
      } catch {}
      try { ctx.emit?.("skills/change"); } catch {}
      // 同步清空本插件会话注入防重缓存，保证同一轮/下一句立即按新版 Skill 生效
      lastInjectedBySession.clear();
    }

    /** 查找一个 Skill 的磁盘可读写路径（若来自只读内置/虚拟源，自动映射到 ~/.dsh/skills/<name>/SKILL.md 覆写） */
    async function locateSkillFile(skillName, cwd) {
      const cleanName = String(skillName || "").trim();
      if (!cleanName || /[\\/\0]|\.\./.test(cleanName)) {
        throw Object.assign(new Error("非法的 Skill 名称"), { status: 400 });
      }
      const list = await listAvailableSkills(cwd);
      const item = list.find((s) => s.name === cleanName);
      const userOverridePath = path.join(dshHome, "skills", cleanName, "SKILL.md");

      // 判断给定路径是否位于真实可写文件系统（排除 app.asar 只读归档内文件）
      const isWritableDiskPath = (p) => {
        if (!p || typeof p !== "string") return false;
        const norm = path.resolve(p);
        if (/\.asar([\\/]|$)/i.test(norm)) return false;
        return fs.existsSync(norm);
      };

      if (item && isWritableDiskPath(item.path)) {
        return {
          name: cleanName,
          filePath: path.resolve(item.path),
          isOverride: false,
          source: item.source || "filesystem",
          description: item.description || "",
        };
      }
      if (fs.existsSync(userOverridePath)) {
        return {
          name: cleanName,
          filePath: userOverridePath,
          isOverride: true,
          source: "user-dsh",
          description: item?.description || "",
        };
      }
      // 虚拟或内置只读 Skill：读取其当前正文，保存时落盘到 ~/.dsh/skills/<name>/SKILL.md 覆写
      const def = await resolveSkillDef(cleanName, null, null);
      if (!def) throw Object.assign(new Error("找不到 Skill: " + cleanName), { status: 404 });
      return {
        name: cleanName,
        filePath: userOverridePath,
        isOverride: true,
        virtualDef: def,
        source: item?.source || "bundled",
        description: item?.description || def.description || "",
      };
    }

    route("skill", "GET", async (_req, res, qs) => {
      const skillName = String(qs.get("name") || "").trim();
      const cwd = qs.get("cwd") || process.cwd();
      const loc = await locateSkillFile(skillName, cwd);
      let rawText = "";
      let existedOnDisk = false;
      if (fs.existsSync(loc.filePath)) {
        rawText = fs.readFileSync(loc.filePath, "utf8");
        existedOnDisk = true;
      } else if (loc.virtualDef) {
        const desc = String(loc.description || loc.virtualDef.description || "").replace(/\r?\n/g, " ").trim();
        rawText = [
          "---",
          "name: " + loc.name,
          "description: " + JSON.stringify(desc),
          "---",
          "",
          String(loc.virtualDef.content || ""),
          "",
        ].join("\n");
      }
      sendJson(res, 200, {
        ok: true,
        name: loc.name,
        filePath: loc.filePath,
        isOverride: loc.isOverride,
        existedOnDisk,
        source: loc.source,
        content: rawText,
      });
    });

    route("skill-save", "POST", async (req, res) => {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      const skillName = String(body.name || "").trim();
      const content = typeof body.content === "string" ? body.content : null;
      if (content === null) throw Object.assign(new Error("content 必须为字符串"), { status: 400 });
      const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd();
      const loc = await locateSkillFile(skillName, cwd);

      fs.mkdirSync(path.dirname(loc.filePath), { recursive: true });
      const tmp = loc.filePath + ".tmp-" + Date.now();
      fs.writeFileSync(tmp, content, "utf8");
      fs.renameSync(tmp, loc.filePath);

      // 立即失效内存 Skill 缓存 + 广播 skills/change + 推进配置 updatedAt，确保热更新毫秒级生效
      invalidateSkillRegistry();
      const curState = readState();
      writeState(curState);
      const refreshedList = await listAvailableSkills(cwd);
      const updatedSummary = refreshedList.find((x) => x.name === loc.name) || null;

      sendJson(res, 200, {
        ok: true,
        name: loc.name,
        filePath: loc.filePath,
        bytes: Buffer.byteLength(content, "utf8"),
        isOverride: loc.isOverride,
        updatedSummary,
        available: refreshedList,
        savedAt: Date.now(),
      });
    });

    return () => { for (const d of disposers) { try { d(); } catch {} } };
  }

  try {
    ctx.inject(["webServer", "connection"], (scope) => installRoutes(scope));
  } catch (e) {
    ctx.logger?.warn?.("dsh-always-skills routes unavailable: " + String(e?.message || e));
  }
}
