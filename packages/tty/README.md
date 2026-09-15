# dsh-tty

The terminal seam these plugins share: the interface a terminal provider implements, and what the terminal tab
allocates its PTY through. A deployment gets it from a provider package below, not by mounting this one.

English | [中文](README.zh.md)

| Provider | Serves |
| --- | --- |
| [tty-local](../tty-local) | terminals on this host |
| [remote-workspace](../remote-workspace) | routes each workspace to the machine that owns it, terminals included |

A terminal can be written to, resized while the shell keeps running, and released.

MIT
