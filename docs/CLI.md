# CLI 用法

服务只有一个命令行入口：`src/main.ts`（日常用 `pnpm dev` 启动）。**启动参数只用于「选哪份
配置文件」**，配置项一律写在配置文件里（见 `config.schema.json` 与 `config.json`）。

## 启动

```bash
pnpm dev                        # 默认配置 @root/config.json
pnpm dev tmp/dev.json           # 位置参数 = 配置文件路径
pnpm dev -c tmp/dev.json        # 等价写法
pnpm dev --config=tmp/dev.json  # 等价写法
pnpm dev -h                     # 显示帮助并退出
```

- 位置参数：配置文件路径（支持 `@root/` 别名）
- `-c, --config <路径>`：指定配置文件（默认 `@root/config.json`）
- `-h, --help`：显示帮助并退出
- 未知参数或缺少路径：打印用法并以退出码 `2` 结束

## 运行中命令

启动后（**仅在交互式终端下生效**）输入命令再回车：

- `r` / `reload`：重新读取配置文件并热更新，打印各 section 的应用结果（已生效 / 需 restart / 未生效）
- `u` / `urls`：显示各服务地址（本服务监听的 HTTP / WebSocket，以及依赖的 MQTT / MySQL）
- `c` / `clear`：清空终端
- `q` / `quit`：退出服务（优雅关闭，走与 `SIGINT` 相同的释放路径）
- `restart`：进程内重启（重新装配全部组件；**仅全名**，防误触）
- `h` / `help`：显示运行中命令清单 + 启动帮助

命令大小写不敏感，短名与全名等价（`restart` 除外）。

## 非交互场景

stdin 不是 TTY 时（`pnpm dev > logs/latest.log`、被进程管理器拉起）**不会**接管输入、
不启动命令循环，服务照常运行；此时用 `SIGINT` / `SIGTERM` 退出（入口带 3s 兜底强退）。

## 实现位置

- `src/main.ts`：入口 —— 解析参数、信号处理、把 `Server` 适配成 `CliHost` 后接管交互
- `src/cli/utils.ts`：`parseArgs` / `COMMANDS` / `resolveCommand` / `helpText` / `USAGE`（纯函数）
- `src/cli/index.ts`：`Cli` 类（readline 交互循环 + 命令执行；只依赖 `CliHost`，与编排解耦）

命令清单、帮助文本、命令解析共用 `COMMANDS` 一份定义，新增命令只需改这一处。
