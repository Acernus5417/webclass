# DSH 网课助手

DeepSeek Harness 0.2.2-rc.5 的 Cordis 插件。安装包内置初始化提示词。首次启用时自动下载并校验固定版本的 DrissionPageMCP、安装运行依赖，然后在专用 Chrome 窗口中打开网课向导。Chrome 调试地址默认为 `127.0.0.1:7891`。

## 安装

需要 DSH 0.2.2-rc.5、已配置的默认模型和 Chrome。首次启动时需要访问 GitHub 和 Python 软件包索引。插件可以自动安装 uv 并创建 Python 3.13 环境。

DSH Desktop 用户应先完全退出客户端，再执行安装命令。

```sh
dsh plugin --profile desktop add https://github.com/Acernus5417/webclass/releases/download/v0.1.0/dsh-webclass-0.1.0.tgz
```

Web 用户可将 `--profile desktop` 换成 `--profile web`。安装已下载的安装包时，可传入 `file:/绝对路径/dsh-webclass-0.1.0.tgz`。Windows 上，若桌面版提供了 `~/.dsh/bin/dsh-electron-cli.cjs`，也可用以下命令安装。

```powershell
node "$env:USERPROFILE/.dsh/bin/dsh-electron-cli.cjs" plugin --profile desktop add 'https://github.com/Acernus5417/webclass/releases/download/v0.1.0/dsh-webclass-0.1.0.tgz'
```

重新打开 DSH。插件加载时会把内置提示词作为首条用户消息原样发送给 DSH 默认模型。初始化每次创建新的 DSH 会话，对模型开放文本输入和输出。只有最终文本以 `超级黑暗大肥鱼:` 开头才进入平台选择。默认最多尝试 3 次，向导中可手动重试。用 `/webclass` 可查看向导地址、错误信息或报告位置。

## 使用流程

1. 输入平台名称或网址，从候选结果确认入口。常用平台使用已知入口。其他名称由 DSH 配置的网页搜索服务查询。
2. 选择手动登录、复用专用窗口内已有的登录状态，或以访客身份进入公开课程。账号、密码、扫码和验证码都在平台网页内处理。
3. 选择只读、全量或有限模式。确认课程页后，可以处理当前页或选定可见章节。直接显示在网页里的 HTML 视频可按正常方式播放并等待结束。
4. 在全量或有限模式下打开练习页，生成参考答案。全量模式支持在你明确确认后填写并提交可识别的同站点标准选择题表单。答案可能有误。自定义播放器、内嵌框架及非标准练习界面需要手动操作。
5. 打开平台的进度或成绩页，回到向导生成报告。报告记录页面显示的实际进度和成绩、操作记录及截图。有限模式的参考答案与报告一起保存在工作区。生成后点击清理按钮关闭专用 Chrome 并移除临时浏览器目录。插件停用时也会清理该目录。

## 配置项

| 配置项 | 默认行为 |
| --- | --- |
| `archive` | 自动下载并校验与原始压缩包同一提交的上游版本，可指定本地 ZIP |
| `promptFile` | 使用包内的 `assets/bootstrap.txt` |
| `workspace` | 优先使用 DSH 工作区，其次使用 DSH 进程的当前目录 |
| `port` | Chrome 使用 `7891` |
| `attempts` | 初始化最多创建 3 个新会话 |
| `chromePath` | 在 Chrome 常用安装位置查找 |
| `pythonPath` | 可指定已装有 DrissionPage 与 MCP SDK 的 Python |
| `uvPath` | 从常用位置或 PATH 查找 uv，缺失时自动下载对应平台的官方发布包 |
| `runtimeDirectory` | 使用 `~/.dsh/webclass-runtime` 缓存安装和专用浏览器目录 |
| `autoStart` | 启用时开始初始化，设为 `false` 后可在 DSH 会话中通过 `/webclass` 启动 |

浏览器操作仅通过插件的 MCP 进程执行，支持已确认课程标签页的可见网页信息和正常网页交互。安装缓存与交付的学习报告、截图和参考答案会在清理后保留。

## 开发

宿主调用使用 DSH 的会话控制器、模型运行时和斜杠命令服务。插件从 `package.json` 的 `dsh.bundle.patch` 声明进入 profile 的 Cordis 配置树。参考实现见 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 [社区插件的 bundle patch](https://github.com/baitouwuya/dsh-mcp-server/blob/main/cordis.patch.yml)。

`npm test` 运行本地测试，覆盖初始化前缀重试、平台解析、模式隔离及报告生成。测试使用合成数据。
