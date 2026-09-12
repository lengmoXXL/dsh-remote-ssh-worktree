/**
 * Bilingual copy for the Remote worktrees settings section.
 *
 * The Chinese dictionary is the key source; the English one is checked against
 * its key set, so a key added to one without the other fails the build. The
 * section receives `t` through the standard locale seat, which the shell
 * derives from the namespace registered in {@link NS}.
 *
 * @module dsh-remote-ssh-worktree/client/locales
 */

/** Locale namespace owned by this plugin's Web UI. */
export const NS = 'remote-worktrees'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  title: '远程 worktree',
  subtitle:
    '管理可以访问的机器、机器上的 git 仓库，以及从仓库切出的 worktree。'
    + '切出的 worktree 会成为一个本地工作区，其文件与命令都在那台机器上执行。',
  refresh: '刷新',
  addMachine: '添加机器',
  loading: '正在加载…',
  machinesEmpty: '还没有配置机器。添加一台机器后，就能浏览它的仓库并切出 worktree。',
  repositoriesEmpty: '这台机器上还没有登记仓库。',
  worktreesEmpty: '这个仓库还没有 worktree。',

  'status.ready': '已连接',
  'status.connecting': '连接中',
  'status.idle': '未连接',
  'status.failed': '连接失败',
  'status.disconnected': '已断开',

  connect: '连接',
  disconnect: '断开',
  removeMachine: '移除机器',
  addRepository: '添加仓库',
  forgetRepository: '移除仓库',
  newWorktree: '新建 worktree',
  bringBack: '合并回主干',
  removeWorktree: '移除',

  branch: '当前分支',
  detached: '游离 HEAD',
  clean: '工作区干净',
  dirty: '有未提交改动',
  localPath: '本地锚点',

  fieldTarget: 'SSH 目标',
  fieldRemotePort: '远端 daemon 端口',
  fieldSshPort: 'SSH 端口',
  fieldIdentityFile: '私钥文件',
  fieldToken: '访问令牌',
  fieldName: '显示名称',
  fieldRepository: '仓库目录',
  fieldWorktreeName: 'worktree 名称',
  placeholderTarget: 'user@build-01',
  placeholderIdentityFile: '~/.ssh/id_ed25519',
  placeholderRepoPath: '/workspace/project',
  placeholderWorktreeName: 'feature-x',
  hintTarget: 'user@主机，或 ~/.ssh/config 里的别名。使用本机 ssh 的密钥与 ssh-agent，不会交互提示密码。',
  hintRemotePort: '远端 daemon 监听的 loopback 端口，即它 --listen 参数里的端口。',
  hintSshPort: '留空则沿用 ssh 自己的配置。',
  hintIdentityFile: '留空则沿用 ssh 的配置与 agent。',
  forwarding: '隧道 127.0.0.1:{port}',
  hintToken: '远端 daemon 启动时写入令牌文件的内容。',
  hintRepository: '该机器上的绝对路径；必须已经是一个 git 仓库。',
  hintWorktreeName: '分支名会变成 worktree/<名称>，名称不可重复。',
  optional: '可选',

  pickDirectory: '浏览目录',
  pickerEmpty: '这个目录下没有子目录。',
  pickerUp: '上一层',
  pickerUse: '使用这个目录',

  requestFailed: '请求失败（{status}）',
  create: '创建',
  cancel: '取消',
  close: '关闭',
  remove: '移除',

  removeMachineTitle: '移除机器？',
  removeMachineBody: '这台机器的仓库登记会一起删除，机器上的 worktree 与分支不受影响。',
  removeRepositoryTitle: '移除仓库登记？',
  removeRepositoryBody: '只会删除本地记录；机器上的仓库和 worktree 都不受影响。',
  removeWorktreeTitle: '移除 worktree？',
  removeWorktreeBody: '会删除机器上的检出目录及其分支，未提交的改动会一并丢弃。',
  noToken: '未设置令牌',
} satisfies Record<string, string>

/** Locale key union this section may translate. */
export type RemoteWorktreesKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  title: 'Remote worktrees',
  subtitle:
    'Manage the machines this deployment can reach, the git repositories on '
    + 'them, and the worktrees cut from those repositories. A worktree becomes '
    + 'a local workspace whose file and shell tools run on that machine.',
  refresh: 'Refresh',
  addMachine: 'Add machine',
  loading: 'Loading…',
  machinesEmpty: 'No machines yet. Add one to browse its repositories and cut worktrees from them.',
  repositoriesEmpty: 'No repositories registered on this machine yet.',
  worktreesEmpty: 'No worktrees in this repository yet.',

  'status.ready': 'Connected',
  'status.connecting': 'Connecting',
  'status.idle': 'Disconnected',
  'status.failed': 'Connection failed',
  'status.disconnected': 'Disconnected',

  connect: 'Connect',
  disconnect: 'Disconnect',
  removeMachine: 'Remove machine',
  addRepository: 'Add repository',
  forgetRepository: 'Forget repository',
  newWorktree: 'New worktree',
  bringBack: 'Merge back',
  removeWorktree: 'Remove',

  branch: 'Branch',
  detached: 'Detached HEAD',
  clean: 'Clean',
  dirty: 'Uncommitted changes',
  localPath: 'Local anchor',

  fieldTarget: 'SSH destination',
  fieldRemotePort: 'Daemon port',
  fieldSshPort: 'SSH port',
  fieldIdentityFile: 'Identity file',
  fieldToken: 'Access token',
  fieldName: 'Display name',
  fieldRepository: 'Repository directory',
  fieldWorktreeName: 'Worktree name',
  placeholderTarget: 'user@build-01',
  placeholderIdentityFile: '~/.ssh/id_ed25519',
  placeholderRepoPath: '/workspace/project',
  placeholderWorktreeName: 'feature-x',
  hintTarget: 'user@host, or an alias from ~/.ssh/config. Uses your local ssh keys and agent; a password is never prompted for.',
  hintRemotePort: 'The loopback port the remote daemon listens on — the port in its --listen argument.',
  hintSshPort: 'Leave blank to use your ssh configuration.',
  hintIdentityFile: 'Leave blank to use your ssh configuration and agent.',
  forwarding: 'tunnel 127.0.0.1:{port}',
  hintToken: 'The contents of the token file the remote daemon was started with.',
  hintRepository: 'An absolute path on that machine that is already a git repository.',
  hintWorktreeName: 'The branch becomes worktree/<name>; the name must be unique.',
  optional: 'optional',

  pickDirectory: 'Browse',
  pickerEmpty: 'No subdirectories here.',
  pickerUp: 'Parent directory',
  pickerUse: 'Use this directory',

  requestFailed: 'Request failed with {status}',
  create: 'Create',
  cancel: 'Cancel',
  close: 'Close',
  remove: 'Remove',

  removeMachineTitle: 'Remove this machine?',
  removeMachineBody: 'Its repository registrations are dropped too. Worktrees and branches on the machine are untouched.',
  removeRepositoryTitle: 'Forget this repository?',
  removeRepositoryBody: 'Only the local record is deleted; the repository and its worktrees on the machine are untouched.',
  removeWorktreeTitle: 'Remove this worktree?',
  removeWorktreeBody: 'The checkout and its branch are deleted on the machine, and uncommitted changes are discarded.',
  noToken: 'no token',
} satisfies Record<RemoteWorktreesKey, string>
