/**
 * dsh-always-skills —— 浏览器前端配置入口（支持按模型精准触发常驻 Skill）
 *
 * 挂载在输入框左下角工具栏（conversation.input.left）：
 *   - 自动感知当前会话选中的模型；当配置了「指定生效模型」且当前模型命中时点亮提示，未命中时显示浅态“本模型跳过”；
 *   - 向上弹出紧凑的双标签配置面板：
 *       1) 「常驻 Skill」：搜索并多选每次对话要加载的 Skill；
 *       2) 「生效模型」：从本机全部可用模型中多选（支持一键“勾选当前会话模型”）；留空表示对所有模型生效。
 *   - 所有修改即时保存到 ~/.dsh/always-skills.json，下一句对话立刻生效，无需重启。
 */
window.__ModuleLoader__.load({
  id: "dsh-always-skills",
  factory: (require) => {
    "use strict";
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    // ── 顶部配置常量 ────────────────────────────────────────────────────
    const 样式标签ID = "dsh-always-skills-styles";
    const 接口前缀 = "/dsh-always-skills/api/";

    // 全局共享状态缓存（多会话/切页即时同步）
    let sharedData = {
      state: { enabled: true, mode: "every-turn", includeSubagents: false, skills: [], targetModels: [] },
      available: [],
      models: [],
      defaultModelKey: "",
      loaded: false,
    };
    const listeners = new Set();
    function notifyAll() {
      listeners.forEach((fn) => { try { fn(sharedData); } catch {} });
    }

    async function apiFetch(sub, method = "GET", body = null) {
      const opts = { method, credentials: "same-origin", headers: {} };
      if (body !== null) {
        opts.headers["content-type"] = "application/json";
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(接口前缀 + sub, opts);
      const data = await res.json().catch(() => ({ ok: false, error: "HTTP " + res.status }));
      if (!res.ok || data.ok === false) throw new Error(data.error || ("HTTP " + res.status));
      return data;
    }

    async function refreshSharedState() {
      try {
        const data = await apiFetch("state-v2", "GET");
        sharedData = {
          state: data.state || sharedData.state,
          available: Array.isArray(data.available) ? data.available : [],
          models: Array.isArray(data.models) ? data.models : [],
          defaultModelKey: typeof data.defaultModelKey === "string" ? data.defaultModelKey : "",
          loaded: true,
        };
        notifyAll();
      } catch {}
    }

    async function saveSharedConfig(patch) {
      const data = await apiFetch("config-v2", "POST", patch);
      sharedData = { ...sharedData, state: data.state || sharedData.state, loaded: true };
      notifyAll();
      return sharedData.state;
    }

    async function fetchSkillSource(skillName) {
      return apiFetch("skill?name=" + encodeURIComponent(skillName), "GET");
    }

    async function saveSkillSource(skillName, content) {
      const data = await apiFetch("skill-save", "POST", { name: skillName, content });
      if (Array.isArray(data.available)) {
        sharedData = { ...sharedData, available: data.available };
        notifyAll();
      }
      return data;
    }

    function useAlwaysSkills() {
      const [snap, setSnap] = useState(() => sharedData);
      useEffect(() => {
        const fn = (next) => setSnap(next);
        listeners.add(fn);
        if (!sharedData.loaded) void refreshSharedState();
        return () => { listeners.delete(fn); };
      }, []);
      return snap;
    }

    /** 读取当前会话正在使用的模型 key ("provider::model") */
    function useCurrentSessionModelKey(props, defaultModelKey) {
      const proj = typeof props?.useProjection === "function"
        ? props.useProjection("modelSelection", (sel) => sel ?? null)
        : null;
      return useMemo(() => {
        const pick = (c) => (c && c.provider && c.model ? (String(c.provider) + "::" + String(c.model)) : "");
        return pick(proj?.next) || pick(proj?.lastUsed) || defaultModelKey || "";
      }, [proj, defaultModelKey]);
    }

    const CSS = `
      .das-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
        -webkit-app-region: no-drag;
      }
      .das-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 28px;
        padding: 0 8px;
        border-radius: var(--dsw-radius-sm, 6px);
        border: 1px solid transparent;
        background: transparent;
        color: var(--dsw-alias-label-secondary, #52525b);
        font-size: 12.5px;
        line-height: 18px;
        cursor: pointer;
        white-space: nowrap;
      }
      .das-btn:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
      }
      .das-btn[data-active="true"] {
        border-color: var(--dsw-alias-border-subtle, rgba(127, 127, 127, 0.24));
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.06));
        color: var(--dsw-alias-label-primary, #18181b);
      }
      .das-btn[data-skipped="true"] {
        opacity: 0.65;
      }
      .das-count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 17px;
        height: 17px;
        padding: 0 5px;
        border-radius: 999px;
        background: var(--dsw-alias-accent-bg, rgba(37, 99, 235, 0.12));
        color: var(--dsw-alias-accent-fg, #2563eb);
        font-size: 11px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .das-count[data-muted="true"] {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.14));
        color: var(--dsw-alias-label-tertiary, #71717a);
      }
      .das-pop {
        position: absolute;
        bottom: calc(100% + 8px);
        left: 0;
        z-index: 9999;
        width: 410px;
        max-width: 92vw;
        border-radius: var(--dsw-radius-md, 10px);
        border: 1px solid var(--dsw-alias-border-subtle, rgba(127, 127, 127, 0.24));
        background: var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-primary, #ffffff));
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16);
        color: var(--dsw-alias-label-primary, #18181b);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .das-pop-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px 8px 12px;
        border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(127, 127, 127, 0.16));
      }
      .das-title {
        font-size: 13px;
        font-weight: 600;
      }
      .das-switch {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--dsw-alias-label-secondary, #52525b);
        cursor: pointer;
        user-select: none;
      }
      .das-tabs {
        display: flex;
        gap: 4px;
        padding: 6px 12px 0 12px;
        border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(127, 127, 127, 0.14));
      }
      .das-tab {
        border: none;
        border-bottom: 2px solid transparent;
        background: transparent;
        color: var(--dsw-alias-label-tertiary, #71717a);
        font-size: 12px;
        font-weight: 500;
        padding: 5px 8px 7px 8px;
        cursor: pointer;
      }
      .das-tab[data-selected="true"] {
        color: var(--dsw-alias-label-primary, #18181b);
        border-bottom-color: var(--dsw-alias-accent-fg, #2563eb);
      }
      .das-controls {
        display: flex;
        flex-direction: column;
        gap: 7px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(127, 127, 127, 0.14));
      }
      .das-search {
        width: 100%;
        box-sizing: border-box;
        height: 30px;
        padding: 0 9px;
        border-radius: var(--dsw-radius-sm, 6px);
        border: 1px solid var(--dsw-alias-border-subtle, rgba(127, 127, 127, 0.25));
        background: transparent;
        color: inherit;
        font-size: 12.5px;
        outline: none;
      }
      .das-search:focus {
        border-color: var(--dsw-alias-accent-border, #2563eb);
      }
      .das-opt-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 11.5px;
        color: var(--dsw-alias-label-tertiary, #71717a);
      }
      .das-select {
        height: 24px;
        padding: 0 6px;
        border-radius: 5px;
        border: 1px solid var(--dsw-alias-border-subtle, rgba(127, 127, 127, 0.25));
        background: var(--dsw-alias-bg-primary, #ffffff);
        color: inherit;
        font-size: 11.5px;
      }
      .das-quick-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 11.5px;
        color: var(--dsw-alias-label-secondary, #52525b);
      }
      .das-mini-btn {
        border: 1px solid var(--dsw-alias-border-subtle, rgba(127, 127, 127, 0.28));
        background: transparent;
        color: inherit;
        font-size: 11.5px;
        padding: 2px 8px;
        border-radius: 5px;
        cursor: pointer;
        white-space: nowrap;
      }
      .das-mini-btn:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.1));
      }
      .das-selected-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        padding: 7px 12px;
        border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(127, 127, 127, 0.12));
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.04));
      }
      .das-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 7px;
        border-radius: 5px;
        border: 1px solid var(--dsw-alias-accent-border, rgba(37, 99, 235, 0.3));
        background: var(--dsw-alias-accent-bg, rgba(37, 99, 235, 0.08));
        color: var(--dsw-alias-accent-fg, #2563eb);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
      }
      .das-pill-x {
        border: none;
        background: transparent;
        color: inherit;
        cursor: pointer;
        padding: 0 1px;
        font-size: 12px;
        line-height: 1;
        opacity: 0.75;
      }
      .das-pill-x:hover { opacity: 1; }
      .das-list {
        max-height: 280px;
        overflow-y: auto;
        padding: 6px 8px;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .das-group-label {
        font-size: 11px;
        font-weight: 600;
        color: var(--dsw-alias-label-tertiary, #71717a);
        padding: 6px 8px 2px 8px;
      }
      .das-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 6px 8px;
        border-radius: var(--dsw-radius-sm, 6px);
        cursor: pointer;
        user-select: none;
      }
      .das-item:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.07));
      }
      .das-item[data-checked="true"] {
        background: var(--dsw-alias-accent-bg, rgba(37, 99, 235, 0.08));
      }
      .das-item-body {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1;
        gap: 2px;
      }
      .das-item-name {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .das-item-desc {
        font-size: 11px;
        line-height: 15px;
        color: var(--dsw-alias-label-tertiary, #71717a);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .das-cur-tag {
        display: inline-block;
        margin-left: 6px;
        padding: 0 5px;
        border-radius: 4px;
        background: rgba(22, 163, 74, 0.12);
        color: #15803d;
        font-family: system-ui, sans-serif;
        font-size: 10.5px;
        font-weight: 500;
      }
      .das-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 7px 12px;
        border-top: 1px solid var(--dsw-alias-border-subtle, rgba(127, 127, 127, 0.14));
        font-size: 11px;
        color: var(--dsw-alias-label-tertiary, #71717a);
      }
      .das-link-btn {
        border: none;
        background: transparent;
        color: var(--dsw-alias-label-secondary, #52525b);
        font-size: 11.5px;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 4px;
      }
      .das-link-btn:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.1));
      }
      .das-skill-row {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        padding: 6px 8px;
        border-radius: var(--dsw-radius-sm, 6px);
      }
      .das-skill-row:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.07));
      }
      .das-skill-row[data-checked="true"] {
        background: var(--dsw-alias-accent-bg, rgba(37, 99, 235, 0.08));
      }
      .das-skill-label {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        flex: 1;
        min-width: 0;
        cursor: pointer;
        user-select: none;
      }
      .das-edit-btn {
        flex: none;
        opacity: 0;
        pointer-events: none;
        height: 22px;
        padding: 0 7px;
        margin-top: 1px;
        border-radius: 5px;
        border: 1px solid var(--dsw-alias-border-subtle, rgba(127, 127, 127, 0.28));
        background: var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-primary, #ffffff));
        color: var(--dsw-alias-label-secondary, #52525b);
        font-size: 11px;
        line-height: 20px;
        cursor: pointer;
        transition: opacity 0.12s ease;
      }
      .das-skill-row:hover .das-edit-btn,
      .das-skill-row:focus-within .das-edit-btn {
        opacity: 1;
        pointer-events: auto;
      }
      .das-edit-btn:hover {
        border-color: var(--dsw-alias-accent-border, #2563eb);
        color: var(--dsw-alias-accent-fg, #2563eb);
      }

      /* Skill 在线编辑器弹层 */
      .das-modal-mask {
        position: fixed;
        inset: 0;
        z-index: 10050;
        background: rgba(0, 0, 0, 0.42);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .das-modal {
        width: min(860px, 94vw);
        height: min(680px, 88vh);
        border-radius: var(--dsw-radius-lg, 12px);
        border: 1px solid var(--dsw-alias-border-subtle, rgba(127, 127, 127, 0.28));
        background: var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-primary, #ffffff));
        color: var(--dsw-alias-label-primary, #18181b);
        box-shadow: 0 20px 56px rgba(0, 0, 0, 0.28);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .das-modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(127, 127, 127, 0.16));
      }
      .das-modal-title-wrap {
        display: flex;
        flex-direction: column;
        min-width: 0;
        gap: 2px;
      }
      .das-modal-title {
        font-size: 14px;
        font-weight: 600;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .das-modal-path {
        font-size: 11px;
        color: var(--dsw-alias-label-tertiary, #71717a);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .das-editor-area {
        flex: 1;
        width: 100%;
        box-sizing: border-box;
        border: none;
        outline: none;
        resize: none;
        padding: 14px 16px;
        background: transparent;
        color: inherit;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 13px;
        line-height: 1.6;
        tab-size: 2;
      }
      .das-modal-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 16px;
        border-top: 1px solid var(--dsw-alias-border-subtle, rgba(127, 127, 127, 0.16));
        font-size: 12px;
      }
      .das-modal-status {
        color: var(--dsw-alias-label-tertiary, #71717a);
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .das-modal-status[data-tone="ok"] { color: #16a34a; }
      .das-modal-status[data-tone="err"] { color: #dc2626; }
      .das-modal-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: none;
      }
      .das-btn-primary {
        height: 30px;
        padding: 0 14px;
        border-radius: 6px;
        border: none;
        background: var(--dsw-alias-accent-fg, #2563eb);
        color: #ffffff;
        font-size: 12.5px;
        font-weight: 500;
        cursor: pointer;
      }
      .das-btn-primary:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .das-btn-ghost {
        height: 30px;
        padding: 0 12px;
        border-radius: 6px;
        border: 1px solid var(--dsw-alias-border-subtle, rgba(127, 127, 127, 0.28));
        background: transparent;
        color: inherit;
        font-size: 12.5px;
        cursor: pointer;
      }
      .das-btn-ghost:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
      }
    `;

    function PinIcon() {
      return h(
        "svg",
        { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { d: "M5.5 2.5h5l-.8 3.6 2.3 2.1v1.3H4V8.2l2.3-2.1-.8-3.6Z" }),
        h("path", { d: "M8 9.5V14" }),
      );
    }

    /** 独立 Skill 内容在线编辑弹层：支持 Ctrl+S 快捷保存并即时热更新 Skill 缓存 */
    function SkillEditorModal({ skillName, onClose }) {
      const [loading, setLoading] = useState(true);
      const [saving, setSaving] = useState(false);
      const [filePath, setFilePath] = useState("");
      const [isOverride, setIsOverride] = useState(false);
      const [content, setContent] = useState("");
      const [origContent, setOrigContent] = useState("");
      const [status, setStatus] = useState({ tone: "muted", text: "正在读取 Skill 文件…" });

      useEffect(() => {
        let alive = true;
        setLoading(true);
        setStatus({ tone: "muted", text: "正在读取 Skill 文件…" });
        fetchSkillSource(skillName)
          .then((res) => {
            if (!alive) return;
            setFilePath(res.filePath || "");
            setIsOverride(Boolean(res.isOverride));
            setContent(res.content || "");
            setOrigContent(res.content || "");
            setStatus({
              tone: "muted",
              text: res.isOverride
                ? "内置/虚拟 Skill：保存后将写入用户目录覆写并热更新立即生效"
                : "修改后按 Ctrl+S 或点击「保存并热更新」立即生效",
            });
          })
          .catch((e) => {
            if (!alive) return;
            setStatus({ tone: "err", text: "读取失败：" + String(e?.message || e) });
          })
          .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
      }, [skillName]);

      const dirty = content !== origContent;

      const handleSave = useCallback(async () => {
        if (loading || saving) return;
        setSaving(true);
        setStatus({ tone: "muted", text: "正在保存并热更新 Skill…" });
        try {
          const res = await saveSkillSource(skillName, content);
          setOrigContent(content);
          setFilePath(res.filePath || filePath);
          setStatus({ tone: "ok", text: "已保存并热更新生效（" + (res.bytes || 0) + " B，下一句对话即按新内容加载）" });
        } catch (e) {
          setStatus({ tone: "err", text: "保存失败：" + String(e?.message || e) });
        } finally {
          setSaving(false);
        }
      }, [skillName, content, loading, saving, filePath]);

      useEffect(() => {
        const onKey = (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void handleSave();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [handleSave, onClose]);

      return h(
        "div",
        {
          className: "das-modal-mask",
          onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); },
        },
        h(
          "div",
          { className: "das-modal", role: "dialog", "aria-label": "编辑 Skill " + skillName },
          h(
            "div",
            { className: "das-modal-head" },
            h(
              "div",
              { className: "das-modal-title-wrap" },
              h("span", { className: "das-modal-title" }, "编辑 Skill：" + skillName + (dirty ? " *" : "")),
              h("span", { className: "das-modal-path", title: filePath }, filePath || (isOverride ? "用户覆写路径" : "加载中…")),
            ),
            h("button", { type: "button", className: "das-btn-ghost", onClick: onClose }, "关闭"),
          ),
          h("textarea", {
            className: "das-editor-area",
            value: content,
            disabled: loading,
            spellCheck: false,
            placeholder: loading ? "加载中…" : "在此编辑 SKILL.md 内容…",
            onChange: (e) => setContent(e.target.value),
          }),
          h(
            "div",
            { className: "das-modal-foot" },
            h("span", { className: "das-modal-status", "data-tone": status.tone, title: status.text }, status.text),
            h(
              "div",
              { className: "das-modal-actions" },
              h("button", { type: "button", className: "das-btn-ghost", onClick: onClose }, "取消"),
              h(
                "button",
                {
                  type: "button",
                  className: "das-btn-primary",
                  disabled: loading || saving,
                  onClick: () => void handleSave(),
                },
                saving ? "保存中…" : "保存并热更新 (Ctrl+S)",
              ),
            ),
          ),
        ),
      );
    }

    function AlwaysSkillsPicker(props) {
      const { state, available, models, defaultModelKey } = useAlwaysSkills();
      const currentModelKey = useCurrentSessionModelKey(props, defaultModelKey);
      const [open, setOpen] = useState(false);
      const [editingSkill, setEditingSkill] = useState("");
      const [tab, setTab] = useState("skills"); // "skills" | "models"
      const [query, setQuery] = useState("");
      const [saving, setSaving] = useState(false);
      const [err, setErr] = useState("");
      const wrapRef = useRef(null);

      useEffect(() => {
        if (!open) return;
        void refreshSharedState();
        const onDocClick = (e) => {
          if (editingSkill) return;
          if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
        };
        const onKey = (e) => {
          if (editingSkill) return;
          if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDocClick);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onDocClick);
          document.removeEventListener("keydown", onKey);
        };
      }, [open, editingSkill]);

      const selectedSkills = useMemo(() => new Set(state.skills || []), [state.skills]);
      const selectedModels = useMemo(() => new Set(state.targetModels || []), [state.targetModels]);

      const modelLabelMap = useMemo(() => {
        const m = new Map();
        for (const item of models) m.set(item.key, item.name || item.model);
        return m;
      }, [models]);

      const resolveSkillLabel = (s) => {
        if (!s) return "";
        if (s.displayName) return s.displayName;
        const m = String(s.description || "").match(/^【([^】]{2,28})】/);
        if (m && m[1] !== "强制") return m[1];
        return "";
      };

      const skillLabelMap = useMemo(() => {
        const m = new Map();
        for (const s of available) m.set(s.name, resolveSkillLabel(s) || s.name);
        return m;
      }, [available]);

      const filteredSkills = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = available.filter((s) => !q
          || s.name.toLowerCase().includes(q)
          || (s.displayName || "").toLowerCase().includes(q)
          || (s.description || "").toLowerCase().includes(q));
        return list.slice().sort((a, b) => {
          const sa = selectedSkills.has(a.name) ? 0 : 1;
          const sb = selectedSkills.has(b.name) ? 0 : 1;
          if (sa !== sb) return sa - sb;
          return a.name.localeCompare(b.name);
        });
      }, [available, query, selectedSkills]);

      const groupedModels = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = models.filter((m) => {
          if (!q) return true;
          return (m.name || "").toLowerCase().includes(q) || (m.model || "").toLowerCase().includes(q) || (m.providerName || m.provider || "").toLowerCase().includes(q);
        });
        const groups = new Map();
        for (const m of list) {
          const gName = m.providerName || m.provider || "default";
          if (!groups.has(gName)) groups.set(gName, []);
          groups.get(gName).push(m);
        }
        return [...groups.entries()];
      }, [models, query]);

      const updateConfig = useCallback(async (patch) => {
        setSaving(true);
        setErr("");
        try {
          await saveSharedConfig(patch);
        } catch (e) {
          setErr(String(e?.message || e));
        } finally {
          setSaving(false);
        }
      }, []);

      const toggleSkill = useCallback((skillName) => {
        const cur = Array.isArray(state.skills) ? state.skills : [];
        const next = cur.includes(skillName) ? cur.filter((x) => x !== skillName) : [...cur, skillName];
        void updateConfig({ skills: next });
      }, [state.skills, updateConfig]);

      const toggleModel = useCallback((modelKey) => {
        const cur = Array.isArray(state.targetModels) ? state.targetModels : [];
        const next = cur.includes(modelKey) ? cur.filter((x) => x !== modelKey) : [...cur, modelKey];
        void updateConfig({ targetModels: next });
      }, [state.targetModels, updateConfig]);

      const skillCount = (state.skills || []).length;
      const modelCount = (state.targetModels || []).length;
      const modelMatched = modelCount === 0 || (Boolean(currentModelKey) && selectedModels.has(currentModelKey));
      const activeNow = Boolean(state.enabled) && skillCount > 0 && modelMatched;
      const skippedByModel = Boolean(state.enabled) && skillCount > 0 && !modelMatched;

      const curModelShort = modelLabelMap.get(currentModelKey) || (currentModelKey ? currentModelKey.split("::").pop() : "");
      const btnTitle = !state.enabled
        ? "常驻 Skill 已暂停"
        : skillCount === 0
          ? "配置每次 AI 对话自动加载的常驻 Skill（支持限定指定模型）"
          : skippedByModel
            ? ("已选 " + skillCount + " 个常驻 Skill，但当前模型「" + curModelShort + "」不在生效模型列表内（本轮跳过）")
            : ("每次对话自动加载 " + skillCount + " 个常驻 Skill：" + (state.skills || []).join(", ") + (modelCount > 0 ? (" · 仅限 " + modelCount + " 个指定模型") : " · 全部模型生效"));

      return h(
        "div",
        { className: "das-wrap", ref: wrapRef, "data-always-skills": "picker" },
        h(
          "button",
          {
            type: "button",
            className: "das-btn",
            "data-active": activeNow ? "true" : "false",
            "data-skipped": skippedByModel ? "true" : "false",
            title: btnTitle,
            onClick: () => setOpen((v) => !v),
          },
          h(PinIcon, null),
          h("span", null, "常驻 Skill"),
          state.enabled && skillCount > 0
            ? h("span", { className: "das-count", "data-muted": skippedByModel ? "true" : "false" }, String(skillCount))
            : null,
        ),
        open
          ? h(
              "div",
              { className: "das-pop", role: "dialog", "aria-label": "配置常驻 Skill 与生效模型" },
              h(
                "div",
                { className: "das-pop-head" },
                h("span", { className: "das-title" }, "常驻 Skill（每次对话自动加载）"),
                h(
                  "label",
                  { className: "das-switch" },
                  h("input", {
                    type: "checkbox",
                    checked: Boolean(state.enabled),
                    onChange: (e) => void updateConfig({ enabled: e.target.checked }),
                  }),
                  h("span", null, state.enabled ? "已开启" : "已暂停"),
                ),
              ),
              h(
                "div",
                { className: "das-tabs" },
                h(
                  "button",
                  { type: "button", className: "das-tab", "data-selected": tab === "skills" ? "true" : "false", onClick: () => { setTab("skills"); setQuery(""); } },
                  "1. 常驻 Skill (" + skillCount + ")",
                ),
                h(
                  "button",
                  { type: "button", className: "das-tab", "data-selected": tab === "models" ? "true" : "false", onClick: () => { setTab("models"); setQuery(""); } },
                  "2. 生效模型 (" + (modelCount === 0 ? "全部" : ("限 " + modelCount + " 个")) + ")",
                ),
              ),
              tab === "skills"
                ? [
                    h(
                      "div",
                      { key: "sc", className: "das-controls" },
                      h("input", {
                        type: "text",
                        className: "das-search",
                        placeholder: "搜索现有 Skill 名称或说明…",
                        value: query,
                        onChange: (e) => setQuery(e.target.value),
                      }),
                      h(
                        "div",
                        { className: "das-opt-row" },
                        h(
                          "label",
                          { style: { display: "inline-flex", alignItems: "center", gap: 5 } },
                          h("span", null, "注入频率"),
                          h(
                            "select",
                            {
                              className: "das-select",
                              value: state.mode || "smart",
                              onChange: (e) => void updateConfig({ mode: e.target.value }),
                            },
                            h("option", { value: "smart" }, "智能防遗忘（极速推荐：首轮/压缩后/每6轮全文，中间轻量提醒）"),
                            h("option", { value: "every-turn" }, "每轮新对话都注入完整正文（较费首字延迟）"),
                            h("option", { value: "every-step" }, "每一步工具循环都强注入完整正文"),
                          ),
                        ),
                        h(
                          "label",
                          { style: { display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" } },
                          h("input", {
                            type: "checkbox",
                            checked: Boolean(state.includeSubagents),
                            onChange: (e) => void updateConfig({ includeSubagents: e.target.checked }),
                          }),
                          h("span", null, "含子智能体"),
                        ),
                      ),
                    ),
                    skillCount > 0
                      ? h(
                          "div",
                          { key: "sp", className: "das-selected-bar" },
                          (state.skills || []).map((sn) =>
                            h(
                              "span",
                              { key: sn, className: "das-pill", title: sn },
                              h("span", null, skillLabelMap.get(sn) || sn),
                              h("button", { type: "button", className: "das-pill-x", title: "移除 " + sn, onClick: () => toggleSkill(sn) }, "×"),
                            ),
                          ),
                        )
                      : null,
                    h(
                      "div",
                      { key: "sl", className: "das-list" },
                      filteredSkills.length === 0
                        ? h("div", { style: { padding: "16px 8px", textAlign: "center", fontSize: 12, color: "var(--dsw-alias-label-tertiary, #71717a)" } }, "未找到匹配的 Skill")
                        : filteredSkills.map((s) => {
                            const checked = selectedSkills.has(s.name);
                            return h(
                              "div",
                              { key: s.name, className: "das-skill-row", "data-checked": checked ? "true" : "false" },
                              h(
                                "label",
                                { className: "das-skill-label" },
                                h("input", { type: "checkbox", checked, style: { marginTop: 2, flex: "none" }, onChange: () => toggleSkill(s.name) }),
                                h(
                                  "div",
                                  { className: "das-item-body" },
                                  (() => {
                                    const cn = resolveSkillLabel(s);
                                    return h(
                                      "span",
                                      { className: "das-item-name", title: cn ? (cn + " (" + s.name + ")") : s.name },
                                      cn ? (cn + " · " + s.name) : s.name,
                                    );
                                  })(),
                                  s.description ? h("span", { className: "das-item-desc", title: s.description }, s.description) : null,
                                ),
                              ),
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: "das-edit-btn",
                                  title: "编辑 " + s.name + " 的内容（保存后立即热更新生效）",
                                  onClick: (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setEditingSkill(s.name);
                                  },
                                },
                                "编辑",
                              ),
                            );
                          }),
                    ),
                  ]
                : [
                    h(
                      "div",
                      { key: "mc", className: "das-controls" },
                      h("input", {
                        type: "text",
                        className: "das-search",
                        placeholder: "搜索模型名称或提供商（留空=所有模型均加载）…",
                        value: query,
                        onChange: (e) => setQuery(e.target.value),
                      }),
                      h(
                        "div",
                        { className: "das-quick-bar" },
                        h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                          currentModelKey ? ("当前模型：" + curModelShort) : "当前模型：未识别"),
                        currentModelKey
                          ? h(
                              "button",
                              {
                                type: "button",
                                className: "das-mini-btn",
                                onClick: () => toggleModel(currentModelKey),
                              },
                              selectedModels.has(currentModelKey) ? "取消当前模型" : "+ 勾选当前模型",
                            )
                          : null,
                      ),
                    ),
                    modelCount > 0
                      ? h(
                          "div",
                          { key: "mp", className: "das-selected-bar" },
                          (state.targetModels || []).map((mk) =>
                            h(
                              "span",
                              { key: mk, className: "das-pill" },
                              h("span", null, modelLabelMap.get(mk) || mk.split("::").pop()),
                              h("button", { type: "button", className: "das-pill-x", title: "移除 " + mk, onClick: () => toggleModel(mk) }, "×"),
                            ),
                          ),
                        )
                      : null,
                    h(
                      "div",
                      { key: "ml", className: "das-list" },
                      groupedModels.length === 0
                        ? h("div", { style: { padding: "16px 8px", textAlign: "center", fontSize: 12, color: "var(--dsw-alias-label-tertiary, #71717a)" } }, "未找到匹配的模型")
                        : groupedModels.map(([gName, list]) => [
                            h("div", { key: "g:" + gName, className: "das-group-label" }, gName),
                            ...list.map((m) => {
                              const checked = selectedModels.has(m.key);
                              const isCur = m.key === currentModelKey;
                              return h(
                                "label",
                                { key: m.key, className: "das-item", "data-checked": checked ? "true" : "false" },
                                h("input", { type: "checkbox", checked, style: { marginTop: 2, flex: "none" }, onChange: () => toggleModel(m.key) }),
                                h(
                                  "div",
                                  { className: "das-item-body" },
                                  h(
                                    "span",
                                    { className: "das-item-name", title: m.provider + " / " + m.model },
                                    m.name || m.model,
                                    isCur ? h("span", { className: "das-cur-tag" }, "当前") : null,
                                  ),
                                  m.name && m.name !== m.model ? h("span", { className: "das-item-desc" }, m.model) : null,
                                ),
                              );
                            }),
                          ]),
                    ),
                  ],
              h(
                "div",
                { className: "das-foot" },
                h(
                  "span",
                  null,
                  err
                    ? ("保存失败：" + err)
                    : saving
                      ? "保存中…"
                      : tab === "skills"
                        ? ("共 " + available.length + " 个 Skill · 已选 " + skillCount + " 个" + (modelCount > 0 ? (" · 限 " + modelCount + " 模型") : " · 全部模型"))
                        : (modelCount === 0 ? ("不限模型（全部 " + models.length + " 个模型均加载）") : ("仅勾选的 " + modelCount + " 个模型生效（留空=全部）")),
                ),
                tab === "skills"
                  ? (skillCount > 0 ? h("button", { type: "button", className: "das-link-btn", onClick: () => void updateConfig({ skills: [] }) }, "清空 Skill") : null)
                  : (modelCount > 0 ? h("button", { type: "button", className: "das-link-btn", onClick: () => void updateConfig({ targetModels: [] }) }, "恢复全部模型") : null),
              ),
            )
          : null,
        editingSkill
          ? h(SkillEditorModal, { skillName: editingSkill, onClose: () => setEditingSkill("") })
          : null,
      );
    }

    const name = "dsh-always-skills";
    const inject = ["slots"];

    function apply(ctx) {
      ctx.effect(() => {
        const el = document.getElementById(样式标签ID) || document.createElement("style");
        el.id = 样式标签ID;
        el.textContent = CSS;
        if (!el.isConnected) (document.head || document.documentElement).appendChild(el);
        return () => { try { el.remove(); } catch {} };
      }, "dsh-always-skills: styles");

      try {
        ctx.slots.inject("conversation.input.left", () =>
          ctx.slots.register(
            { name: "conversation.input.left", id: "dsh-always-skills-picker", order: 60 },
            (props) => h(AlwaysSkillsPicker, props),
          ));
      } catch {}
    }

    return { name, inject, apply };
  },
});
