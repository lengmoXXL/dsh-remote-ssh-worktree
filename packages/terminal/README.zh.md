# dsh-terminal

[English](README.md) | 中文

在 DeepSeek Harness Web GUI 的**右侧 Sidebar** 里放一个终端，用
[xterm.js](https://xtermjs.org/) 绘制，背后是真正的 PTY。

点开右侧栏的添加按钮，guide 里会多出一个 **终端** 胶囊，和「文件」「Git」
并列——它走的是这两个类型同样的两阶段注册，右侧栏没有为这个插件开任何特例。

## 打开在哪里

会话自己的工作区目录。浏览器只发一个会话身份，不发路径：host 从该会话的
header 解析出工作区（和其他所有按工作区取数的读取方完全一致），再通过
`ctx.tty` 分配终端。

这一个接缝就是全部的远程故事。被
[dsh-remote-workspace](https://github.com/lengmoXXL/dsh-remote-workspace)
路由的工作区，其名字就是本地 anchor 路径，路由版的终端 provider 会把该
路径解析到对应节点，并在**那台机器上**起 shell——同一条代码路径，这里完全
不需要知道有哪些机器。没有装路由插件时，所有工作区就都是本地的。

shell 是哪台机器自己的登录 shell，在有工作区的那台机器上解析：argv 是
`/bin/sh -c 'exec "${SHELL:-/bin/sh}" -l'`，所以同时管着一台 Mac 和一个
Linux 节点的部署，会在前者起 zsh、后者起 bash。想钉死一个就配 `shell` 和
`shellArgs`。

## 终端的生命周期

一个 socket 就是一个终端。浏览器把它的 xterm 实例、回滚缓冲、DOM 元素和
socket 放在一个按 tab 记录的条目里，这个条目比渲染它的 React 组件活得久——
右栏只渲染当前激活的 tab，如果终端随组件一起销毁，每次切 tab 就会丢掉
shell。所以隐藏 tab、切会话、收起右栏都不花代价；只有 tab 记录消失（其
abort signal 是唯一会拆掉这个条目的东西）才会关掉 socket，host 随即杀掉
PTY。关掉浏览器标签页不会留下任何 shell。

## 调整大小

面板量出来的尺寸驱动 PTY：`ResizeObserver` 调 `fit()`，每次变化都把新尺寸
发给 host。

`resize` 是终端接缝（`ctx.tty`）自己的动词，host 直接调用，不需要先问是哪一种
provider 作答：本地 provider 设置 PTY 的窗口尺寸，节点上的终端则走 `term.resize`，
远程 agent 在 **0.0.2** 才有。拒绝调整的 provider——还在跑 0.0.1 的节点——会让终端
保持在打开时的尺寸，状态栏会直说这件事，而不是让一个不更新的布局自己去解释。

## 沙箱

终端**不受**会话沙箱模式约束。那个策略限制的是 agent 能做什么；终端是人
自己的 shell，由人自己启动，所有编辑器的终端都是这个语义。还有一个机械上
的原因：`ctx.sandbox` 生成的是**本机**内核的包装，把它套到属于另一台机器的
工作区上，等于把 `sandbox-exec` 或 `bwrap` 送到一个两者都没有的节点上。

## 安装

插件以一行 Loader 条目挂载，两种方式选一种：

**作为 bundle**——发布形态。把依赖和 bundle 加进 profile，然后重启：

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dsh": { "profile": { "bundles": ["…", "dsh-terminal"] } },
  "dependencies": { "dsh-terminal": "link:/Users/lzy/Projects/dsh-terminal" }
}
```

```sh
dsh plugin --profile web install          # 链接本包
```

**通过 profile 的 patch 层**——开发时用的形态。
`$DSH_HOME/profiles/<name>/cordis.patch.yml` 是被实时监听的
（`patchReload: live`），所以 host 半边不用重启就能挂上：

```yaml
- insert:
    - id: dsh-terminal
      name: dsh-terminal
```

不要两种都做：那一行会被插入两次。本包自带 `cordis.patch.yml`，这正是
bundle 方式能工作的原因；把它列进 `bundles` **并且**手工 insert 是组合错误。

client 半边是 shell 从 `/plugins/??dsh-terminal/client.js` 取的动态 bundle。
已经打开的页面用的是它加载时那份，所以重新构建后需要刷新页面——loader 会
重新哈希产物，刷新即拿到新版本。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `shell` | 未设置 | 要运行的程序。未设置则用机器自己的登录 shell。 |
| `shellArgs` | `['-l']` | `shell` 之后的参数。`shell` 未设置时忽略。 |
| `graceMs` | `3000` | 单个终端会话的 TERM 到 KILL 宽限期。 |

## 协议

一条 WebSocket，路径 `/dsh-terminal/ws`，和所有 `/api` 请求走同一道浏览器
信任检查——握手会带 cookie，且不受同源策略保护，没有这道闸任何页面都能在
这台机器上开 shell。

text 帧走 JSON 控制（上行 `open`、`input`、`resize`；下行 `ready`、`size`、
`exit`、`error`），**binary** 帧下行承载裸终端字节，shell 的输出不必逐块
base64。输出一块一块地走：刷屏的命令会让 PTY 的输出流暂停，而不是在 host
进程里堆一个无界队列。

## 开发

```sh
npm install
npm run typecheck    # host 与 client 两半
npm test             # 单元测试
npm run build        # lib/index.js（host）+ lib/client.js（浏览器 bundle）
npm run watch        # 改动时重建 client 半边
```
