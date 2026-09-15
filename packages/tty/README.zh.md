# dsh-tty

这些插件共用的终端接缝：终端 provider 实现的接口，也是终端标签页分配 PTY 的入口。
部署时由下面的 provider 包提供，不需要单独挂载本包。

[English](README.md) | 中文

| provider | 负责 |
| --- | --- |
| [tty-local](../tty-local) | 本机的终端 |
| [remote-workspace](../remote-workspace) | 把每个工作区（含终端）路由到拥有它的机器 |

终端可以写入、在 shell 继续运行的同时改变尺寸、以及释放。

MIT
