# dsh-always-skills

适用于 **DeepSeek Harness (DSH)** 的持久化常驻 Skill 自动注入插件：在每次 AI 对话前按配置自动重新注入指定的 Skill 正文，防止长对话或上下文压缩后模型遗忘核心规则。

## 核心特性

- **可视化多选配置**：在 DSH 输入框左下角挂载 `常驻 Skill` 按钮，支持搜索、勾选一个或多个本机已有 Skill，配置持久化保存至 `~/.dsh/always-skills.json`，即时生效、无需重启。
- **按当前模型精准触发**：支持在「生效模型」页勾选特定模型（支持一键勾选当前会话模型）；命中指定模型时每轮自动注入，切到其他模型时自动跳过；留空则对全部模型生效。
- **两种注入频率与子智能体开关**：
  - `every-turn`（默认推荐）：每轮新用户输入到达时自动加载一次，同轮多步工具循环不重复灌水；
  - `every-step`：每一步模型请求均强注入；
  - 可选开启「含子智能体」，同步覆盖派生的子智能体会话。
- **悬停在线编辑 + 热更新生效**：在 Skill 列表项上悬停点击「编辑」即可直接修改对应 `SKILL.md` 内容，按 `Ctrl+S` 或点击「保存并热更新」原子写盘并立即清空 DSH `SkillRegistry` 缓存、广播 `skills/change`，下一句对话立即按新版正文注入（对只读内置 Skill 自动覆写至 `~/.dsh/skills/<name>/SKILL.md`）。
- **零侵入标准协议**：通过 Cordis `agent/pre-step` 瀑布钩子以官方 `<skill_content>` 块与 `source.kind = "skill-invocation"` 注入，不修改 `app.asar`，完全兼容官方聊天视图与 Skill 展示插件。

## 安装方式

### 方式一：通过 DSH 插件市场 / Git URL 直接安装

在 DSH 侧边栏 **插件** 页安装本仓库地址：

```text
https://github.com/zt1901/dsh-always-skills.git
```

### 方式二：本地链接到 Desktop Profile（推荐开发与二次修改）

1. 克隆本仓库到本地目录（例如 `C:\dsh-plugins\dsh-always-skills` 或 `~/dsh-plugins/dsh-always-skills`）：

```bash
git clone https://github.com/zt1901/dsh-always-skills.git
```

2. 在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 中加入 `dsh-always-skills`：

```json
{
  "dependencies": {
    "dsh-always-skills": "link:C:/dsh-plugins/dsh-always-skills"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-always-skills"
      ]
    }
  }
}
```

3. 在 `~/.dsh/profiles/desktop/node_modules/` 下创建指向插件目录的符号链接（或执行 `pnpm install`），DSH 启用 HMR 时自动热载入，否则重启 DSH 生效。

## 持久化配置格式

配置文件位于 `~/.dsh/always-skills.json`（由前端界面自动读写，也可手动编辑）：

```json
{
  "enabled": true,
  "mode": "every-turn",
  "includeSubagents": false,
  "skills": [
    "chinese-code-comments"
  ],
  "targetModels": [
    "deepseek::deepseek-chat"
  ]
}
```

- `skills`：每次对话自动加载的 Skill 名称数组（最多 30 个）。
- `targetModels`：生效模型列表（格式为 `"provider::model"`）；留空数组 `[]` 表示对全部模型生效。
- `mode`：`"every-turn"`（每轮新对话加载一次）或 `"every-step"`（每步工具循环都注入）。
- `includeSubagents`：是否对派生子智能体生效。

## 许可证

[MIT](LICENSE)
