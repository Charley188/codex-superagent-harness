# Codex Superagent Harness

一个以 **Codex 为执行引擎**的本地网页工作台：在统一界面管理工作区、聊天、Router、并行 Worker、工单和交付审核。借鉴并复用 DeepSeek Harness / DSH Superagent 的界面和编排代码，适配 Codex CLI、会话协议及 Windows 宿主。

这是独立的社区适配项目，不是 OpenAI 或 DeepSeek 的官方产品，也尚未完整实现 DSH Harness 的全部功能。目前以 **Windows 本地使用、合成测试验收**为主要验证范围。

## 可以做什么

| 功能 | 当前状态 |
| --- | --- |
| Codex 桌面风格 | 中性深灰主题、系统字体、紧凑侧栏与线性图标；会话、设置与弹窗统一配色 |
| 统一网页、工作区侧栏、普通聊天 | 已接入 Codex 会话；普通聊天目前以文本为主 |
| Superagent 六个管理页面与主 Session 入口 | 已接入；部分设置仍明确标注未实现 |
| Router 分工、依赖、Worker 消息、Watchdog | 已实现持久化调度与恢复，任务结果可人工审核 |
| Worker 并发 | 页面可配置 **1–16**；合成真实模型验收覆盖 4 路，调度测试覆盖 16 路 |
| Worker 执行时限 | 默认 20 分钟，执行设置可调整为 1–120 分钟；新回合和重试使用保存的时限 |
| 侧栏工作区与会话管理 | 工作区可移除、恢复；普通会话和 Worker 会话可归档、取消归档 |
| 提示词编辑、预览、版本及恢复 | 已接通后续请求快照，权限仍由宿主约束 |
| 新增本地项目、选择文件夹 | Router、普通会话及 Worker 可按需查找、读取当前文件；追问可读取新版 Word |
| 代码交付与登记作业 | 编辑 Worker 在独立副本内修改代码、执行本地测试；不会自动覆盖原项目 |
| GitHub Issue / PR、飞书接单 | 尚未接通外部渠道，不需要 bot 账号才能本地使用 |
| 完整文件树、终端、插件市场、自动化任务 | 尚未实现 |

详细边界见 [功能与架构](docs/architecture.md)，实测结果见 [首次公开版本验证](docs/validation.md)。界面配置可见，不代表所有上游能力已经移植。

## 快速开始（PowerShell）

准备 Windows 10/11、Git、Node.js **22.19+（22.x）或 24+**、Python **3.12+**、pnpm 和 npm，以及已经登录的 Codex CLI。当前适配基于 Codex `0.166.0-alpha.5.1` 验证；其他版本必须通过本机兼容性检查。托盘程序和文件夹选择器使用 Windows 自带 .NET Framework C# 编译器。

```powershell
git clone https://github.com/Charley188/codex-superagent-harness.git
cd codex-superagent-harness
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\test.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\certify.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

`setup.ps1` 安装锁定依赖、构建网页、建立本地配置和合成示例；不导入作者的历史会话或认证结果。Codex 不在 PATH 时，首次安装使用 `-Codex '完整的 codex.exe 路径'`。

`test.ps1` 运行不调用模型的回归；`certify.ps1` **会使用已登录 Codex 的模型额度**，验证沙箱、会话续接、真实并行、恢复与交付。认证失败会保留日志并阻止启动，不应手工伪造验收文件。详见 [安装、运行与升级](docs/operations.md)。

启动后自动打开浏览器并驻留托盘。使用左侧工作区入口创建项目和聊天，进入 Superagent 后点击“打开主 Session”与 Router 对话；在执行设置调整并发。关闭网页不会关闭后台，退出请使用托盘菜单或：

```powershell
.\start.ps1 status
.\start.ps1 shutdown
```

登记工作文件夹后，可以直接说“读取目录里的某文件”。修改原文件或添加新版后，在原对话中要求重新读取即可，无需重建项目。文件在工具调用时读取，并保留路径、SHA256 与读取版本；旧快照不再限制当前访问。读取支持 UTF-8 文本及 DOCX/PPTX/XLSX 文本提取，PDF 需要额外安装 `pypdf`；不支持的格式会明确报错。每文件上限 20 MB，长文本分页读取。

## 仓库结构

```text
README.md / docs/             使用说明、架构、来源与发布范围
setup.ps1 / test.ps1          安装与离线回归
certify.ps1 / start.ps1       本机兼容性验收、启动和管理
prototypes/dsh-core/          当前活动框架（保留路径以兼容相对导入）
  framework/                 Router、Watchdog、会话、API、验收工具
  src/ / adapted/            持久执行适配与 DSH 模块适配
  panel/                     网页入口、构建及 UI 回归
  vendor/dsh/                 固定版本的上游源码及 MIT 许可
  tests/                     编排、会话和安全边界回归
app/research_ops/            Codex 进程、契约及兼容性支撑模块
app/tests/                  支撑模块回归
desktop/                    Windows 托盘启动器与 UI 测试宿主
tests/fixtures/             两份公开的合成输入
tools/                      安装辅助程序
```

名称中的 `prototypes` 是历史路径；这里只有当前活动框架，没有早期废弃草稿。`app` 中保留的旧队列支撑代码仍被兼容性验收和测试使用，不能按“中间程序”直接删除。

运行后生成的 `state/`、`workspaces/`、`config.local.json`、网页构建产物和依赖目录均不入库。仓库不含私人知识库、专利材料、真实任务日志、账号令牌或本机验收证书。

## 来源与许可

原始 DSH 源码保留 MIT 许可及哈希清单，适配改动分目录管理。详见 [第三方来源](THIRD_PARTY_NOTICES.md) 和 [MIT License](LICENSE)。原版源码、Codex 适配与本地扩展的区别见架构说明。
