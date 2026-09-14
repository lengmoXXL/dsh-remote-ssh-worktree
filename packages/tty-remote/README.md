# dsh-tty-remote

Terminal provider for terminals owned by a node daemon. [remote-workspace](../remote-workspace) uses it for
workspaces on other machines, so a deployment does not mount or configure it directly.

English | [中文](README.zh.md)

Output from the node is published as an ordinary readable stream, and the terminal can be written to, resized, and
released the same way as a local one.

MIT
