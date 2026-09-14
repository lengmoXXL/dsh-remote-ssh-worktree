# dsh-terminal

Web GUI 右侧边栏里的终端：每个会话一个 xterm.js 标签页，开在该会话的工作区——本机，或拥有该工作区的机器。
兄弟包：[remote-workspace](../remote-workspace)。

[English](README.md) | 中文

## 能做什么

- 在会话的工作区目录里打开该机器自己的登录 shell；也可以用 `shell` 和 `shellArgs` 指定别的程序。
- 隐藏标签页、切换会话、收起边栏都不会中断 shell；关闭标签页才结束它，浏览器标签页关掉不会留下 shell。
- 跟随面板尺寸变化：本机和节点上都可调整；机器不支持调整时，状态栏会说明尺寸已过期。
- 不受会话沙箱模式约束——它是你自己的 shell，不是 agent 的。

## 安装

```sh
git clone https://github.com/lengmoXXL/dsh-remote-workspace
cd dsh-remote-workspace && npm install && npm run build
dsh plugin --profile web add "$PWD/packages/terminal"
```

重启服务即可加载。

开发时改用 profile 的 patch 层挂载 host 半边，无需重启
（`$DSH_HOME/profiles/<name>/cordis.patch.yml`，实时监听）：

```yaml
- insert:
    - id: dsh-terminal
      name: dsh-terminal
```

两种方式只用一种：既列进 `bundles` 又手工 insert 会把这一行挂载两次。重新构建后请刷新页面——已打开的页面
仍使用它加载时那份 client bundle。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `shell` | 未设置 | 要运行的程序。未设置则用机器自己的登录 shell。 |
| `shellArgs` | `['-l']` | `shell` 之后的参数；`shell` 未设置时忽略。 |
| `graceMs` | `3000` | 关闭终端时留给它退出的时间（毫秒）。 |

MIT
