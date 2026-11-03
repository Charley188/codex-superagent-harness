# 安装、运行与升级

所有命令从仓库根目录的 PowerShell 运行。`setup.ps1` 可重复运行；已有本地配置会保留。首次初始化失败时检查提示，不要删除已有生产运行目录来重试。

## 安装与验证

1. `setup.ps1`：初始化本机路径，安装锁定依赖，构建网页并创建合成项目。
2. `test.ps1`：Python、Node、UI 回归及上游来源校验，不调用真实模型。
3. `certify.ps1`：使用合成材料验证当前 Codex 版本、沙箱与续接，再运行完整框架验收。会消耗模型额度，可能需要数分钟。
4. `start.ps1`：编译并启动 Windows 托盘宿主，自动打开网页。

不要将别人机器上的 `state/compatibility-accepted.json` 或 `state/framework-accepted.json` 复制到自己的安装目录。源码、CLI 或策略变更可能使认证失效，需要重新验收。

`app` 的 `max_workers` 是兼容性支撑层的旧队列配置，不能用它调整网页 Worker 并发。日常并发在 **Superagent → 设置 → 执行** 中调整，范围 1–16。

## 管理

```powershell
.\start.ps1 status
.\start.ps1 pause
.\start.ps1 resume
.\start.ps1 doctor
.\start.ps1 backup
.\start.ps1 shutdown
```

`-Foreground` 可让启动过程留在当前终端，`-NoBrowser` 禁止自动开页。后台模式从托盘退出；关闭浏览器只关闭页面。

运行目录位于 `state/dsh-core/framework-local/`。`connection.json` 的完整链接带本地访问令牌，不能公开分享。日志、项目快照和模型对话可能包含用户输入，全部留在忽略目录里。

## 升级与排错

升级前结束或核对活跃/不确定执行，备份，再关闭服务。更新代码后重新运行 setup、test 和 certify。不要在运行中覆盖数据库，也不要跳过因为协议变化而失败的检查。

- 依赖下载失败：检查网络后重跑 setup。
- `Codex/adapter/policy recertification required`：重新运行 certify，查看 `state/compatibility/` 日志。
- `Framework code/dependencies changed`：重新构建并运行完整 certify。
- 网页无法访问：检查托盘状态及 `state/desktop/`、运行目录内日志；链接令牌不可删掉。
- 部分配置标注未实现：见架构能力表，不会因为填写表单就自动启用。

服务只绑定本机回环接口。不要把带令牌的本地链接或端口直接发布到互联网。
