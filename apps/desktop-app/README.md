# honeycomb 桌面应用

这里是 honeycomb 的 Tauri + React 桌面控制台。

桌面应用连接本地 `orchestrator-api`，用于完成首次配置、管理 Agent 团队、创建任务、切换编排模式、检查消息与时间线，以及取消正在运行的任务。

## 首次启动

首次打开时会按顺序完成：

```text
界面引导
配置 Provider 与 API Key
渐进式工作访谈
生成工作画像与 Agent 团队
写入本地安全配置
解锁完整控制台
```

原始 API Key 只保留在当前运行状态中，不会写入生成的 Agent 提示词文件。

首次启动生成的配置保存在应用数据目录中的 `desktop-first-run`：

```text
first-run-profile.json
cluster.config.json
agents/<agent-id>/AGENTS.md
```

## 开发运行

先启动后端：

```powershell
docker compose up --build
```

再启动桌面开发模式：

```powershell
npm install --prefix apps/desktop-app
npm --prefix apps/desktop-app run tauri:dev
```

只运行浏览器开发界面：

```powershell
npm --prefix apps/desktop-app run dev
```

## 构建与检查

```powershell
npm --prefix apps/desktop-app run build
npm --prefix apps/desktop-app exec tauri build -- --no-bundle
npm run smoke:desktop-onboarding
npm run smoke:desktop-ui-prod
npm run smoke:tauri-shell
```

Windows 桌面构建需要 Rust、MSVC 与 Windows SDK。
