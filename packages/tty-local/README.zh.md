# dsh-tty-local

[English](README.md) | 中文

本机的终端 provider，基于 node-pty。没有路由器的部署可以挂载它：

```yaml
- insert:
    - id: dsh-tty-local
      name: dsh-tty-local
```

运行 [remote-workspace](../remote-workspace) 的部署不需要挂载它：那个插件自己提供本机终端。

- 用本机环境加 `TERM=xterm-256color` 运行调用方指定的程序。
- 把运行中的终端调整到调用方要求的尺寸，全屏程序据此重绘。
- 释放终端时先发信号，超过 `graceMs` 再杀掉。
- 没有配置项。

MIT
