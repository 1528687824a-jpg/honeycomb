# Honeycomb 跨平台适配设计（阶段 E，刻意最后执行）

用户分布覆盖 Windows、WSL2、Linux、macOS、iOS。本设计先定架构边界，
实施排在产品功能研发完成之后（见 backend-roadmap.md 的工作计划阶段 E）。

## 现状盘点

已经跨平台的部分：

- orchestrator-api / dbos-worker / Postgres：Node + Docker，三平台可跑。
- Tauri 桌面框架本身支持 Windows/macOS/Linux 构建。
- WSL/Docker 主机诊断已做环境感知（容器内、非 Windows 自动跳过）。

Windows 专属耦合点（跨平台要解决的全部清单）：

1. OpenClaw 执行链：`apps/dbos-worker/src/adapters/openclaw.ts` 通过
   `wsl -d <distro>` 调用 CLI。
2. 密钥存储：`packages/runtime/src/local-secrets.ts` 与桌面端
   `main.rs` 都用 Windows DPAPI（PowerShell ProtectedData）。
3. 启动/停止/smoke 脚本全部是 PowerShell。
4. 桌面快捷方式与 launcher 仅 Windows。
5. 真实 E2E 就绪诊断假定 WSL 路径。

## 设计原则

1. 后端 API 契约不变；平台差异收敛到三个适配层：
   进程执行、密钥存储、启动器。UI 与编排逻辑零分叉。
2. iOS 不做原生 App。定位是"远程伴侣"：IM 渠道（阶段 D 成果）+
   PWA/web 面板 + 每设备 token 与短时 SSE ticket（HONEYC~3 既定方案）。
3. headless Linux 服务器与"全栈跑在 WSL2 里"的用户走同一条路径：
   docker compose + web 面板。
4. 桌面体验（Tauri）只承诺 Windows/macOS/Linux 桌面三端。

## 平台矩阵

| 平台 | UI | OpenClaw 执行 | 密钥存储 | 启动器 |
| --- | --- | --- | --- | --- |
| Windows | Tauri（现有） | WSL 包装（现有） | DPAPI（现有） | PowerShell（现有） |
| macOS | Tauri 构建 | 本机 CLI 直调 | Keychain | bash |
| Linux 桌面 | Tauri 构建 | 本机 CLI 直调 | libsecret，回退加密文件 | bash |
| Linux 服务器 / WSL2 | web 面板（PWA） | 本机 CLI 直调 | 口令派生加密文件 | docker compose |
| iOS | PWA + IM 渠道 | —（远程访问） | 每设备 token | — |

## 三个适配层

### 1. 进程执行适配层（改动最小，最先做）

- `runOpenClawAgent` 拆出 `buildHostCommand(platform)`：
  win32 返回现有 `wsl -d <distro> -- timeout ...` 包装；
  linux/darwin 直接返回 `timeout ... openclaw agent ...`。
- Linux 侧 `timeout --kill-after` 包装两条路径共用，孤儿进程治理不回退。
- 既有单测 `buildOpenClawAgentArgs` 扩展平台参数即可回归。

### 2. 密钥存储适配层

- `packages/runtime/src/local-secrets.ts` 抽出 SecretBackend 接口：
  `protect(plaintext) / unprotect(envelope)`，envelope 带 format 标记
  （现有 `dpapi-user-v1` 即第一个实现）。
- 新增 format：`keychain-v1`（macOS `security` CLI 或 keyring 库）、
  `libsecret-v1`（Linux 桌面）、`age-passphrase-v1`（headless 回退，
  启动时口令派生密钥）。
- 读取按 envelope format 分发，与平台无关；写入按当前平台选最强后端。
- 现有规则保留：识别出的加密 envelope 解密失败绝不回退明文。

### 3. 启动器与构建

- PowerShell 脚本逐个补 bash 等价物（start/stop/tryout/smoke）。
- Tauri 增加 macOS/Linux 构建目标与 CI 矩阵；桌面端 Rust DPAPI 调用
  走与后端相同的 SecretBackend 策略。
- web 面板：orchestrator-api 静态托管现有 React 构建产物（desktop-app
  的 UI 层本就是 React，把 Tauri invoke 调用面收敛到已有的 API
  fallback 路径即可），加 PWA manifest 供 iOS 添加到主屏幕。

## 实施顺序（阶段 E 内部）

1. 进程执行适配层（解锁 Linux 上的真实 OpenClaw 验证）。
2. 密钥 SecretBackend 抽象 + headless 加密文件回退。
3. bash 启动器 + docker compose headless 文档。
4. macOS Keychain / Linux libsecret 实现。
5. Tauri macOS/Linux 构建与冒烟。
6. web 面板托管 + PWA + 每设备 token/SSE ticket（与阶段 D 远程认证合流）。
7. 跨平台安装器验证 + Alpha 发布。

## 不做的事

- iOS/Android 原生 App。
- 在 Windows 上绕开 WSL 直跑 OpenClaw（保持单一可信执行环境）。
- 为 headless 模式单独再写一套 UI（复用桌面 React 构建产物）。
