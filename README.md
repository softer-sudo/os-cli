# os-cli

A tiny Node.js + TypeScript CLI that makes operating-system fundamentals
tangible: processes, IPC, file handles and access rights, background
services, least-privilege security. Node built-ins only; no runtime
dependencies.

## Quick start

Needs Node >= 24 (runs the TypeScript sources directly; `npm run build` emits plain JS for the service).

```bash
npm install
npm test
npm run build

node dist/cli.js queue --workers 2 README.md package.json
```

```console
{"file":".../README.md","id":0,"pid":27131,"handled":1,"bytes":6888,"sha256":"9fc4aa94..."}
{"file":".../package.json","id":1,"pid":27132,"handled":1,"bytes":546,"sha256":"ccdd2cd3..."}
```

Two jobs, two different PIDs: each worker is its own OS process.

## Commands

| Command | What it does |
|---|---|
| `queue [--workers n] <file...>` | Hashes files on a pool of worker processes and prints one JSON result per file |
| `serve --config <file>` | Watches a directory and hashes whatever changes; this is the service entry point |

Exit codes follow `sysexits.h`: `0` ok, `1` error, `64` usage, `77` permission denied, `78` bad config.

## OS concepts, mapped to code

| Concept | Where | What to look at |
|---|---|---|
| **Process & thread management** | `src/pool.ts` | `spawn()` creates real child processes (own PID, own scheduler entry). A queue feeds idle workers one job at a time; a worker that dies is replaced and its job reports `EWORKER`. Node's main thread is one event loop, file I/O runs on libuv's thread pool; processes (not `worker_threads`) are used here because a crash or a denied syscall stays contained. |
| **IPC** | `src/pool.ts`, `src/worker.ts` | Anonymous **pipes** on the child's stdin/stdout carrying newline-delimited JSON. One job in flight per worker gives natural backpressure. Closing the pipe (EOF) is the shutdown signal. |
| **File system: access rights, shared access, performance** | `src/worker.ts`, `src/serve.ts` | `open(O_RDONLY)` asks for read access only and returns a handle (file descriptor); `O_NOFOLLOW` refuses symlinks. Every handle is closed in `finally`. Files are streamed in chunks, so a 3 GB file costs the same memory as a 3 KB one. Readers take no lock: POSIX readers never block writers (on Windows Node opens files with `FILE_SHARE_READ \| WRITE \| DELETE` for the same effect), so a read can race a writer and the writer's next change event simply re-hashes. The watcher uses `fs.watch` (kqueue / inotify / ReadDirectoryChangesW) and debounces the burst of events a single save produces. |
| **Services / daemons** | `service/dev.os-cli.plist`, `scripts/service.sh` | launchd job with its own JSON config, stdout/stderr log files, `KeepAlive` restart on non-zero exit, `ThrottleInterval` against restart storms, `ExitTimeOut` for graceful stop. |
| **OS security & authorization** | `src/serve.ts`, `src/pool.ts` | Refuses to run as root. Config must be owned by the service user (or root) and not group/world-writable, because it decides which directory is read. Workers run under Node's **permission model** (`--permission --allow-fs-read=<dir>`) so even a compromised worker can read only the watched directory. Service umask is `077`. |
| **Memory protection** | `src/worker.ts` | Each process has its own virtual address space enforced by the MMU. `handled` is a module variable in every worker: the results show it counting independently per PID, and the parent never sees it. The only way data crosses is the pipe. `SharedArrayBuffer` is the explicit opt-in to sharing and is deliberately not used. |
| **Application interoperability** | `src/worker.ts`, `src/common.ts` | The worker protocol is JSON lines on stdio, so a worker can be rewritten in any language. Logs are JSON lines (`jq`-friendly), the config is JSON, failures use standard exit codes, shutdown is a standard signal. |

## Graceful shutdown

`SIGINT`/`SIGTERM` makes `serve` stop the watcher, cancel pending debounce timers, let in-flight jobs finish, close each worker's stdin, and `SIGKILL` any worker still alive after 3 s. It then exits `0`. If the service itself is killed hard, workers see EOF on their pipe and exit on their own, so nothing is orphaned.

## Running as a service (macOS)

```bash
npm run build
scripts/service.sh install      # copies dist/ to ~/Library/Application Support/os-cli/app, loads the job
scripts/service.sh uninstall
```

| Thing | Location |
|---|---|
| Config | `~/Library/Application Support/os-cli/config.json` (`{ "watchDir": "...", "workers": 2 }`, mode 0600) |
| Logs | `~/Library/Logs/os-cli/out.log` and `err.log` |
| Inbox | `~/os-cli-inbox` |

```bash
cp README.md ~/os-cli-inbox/        # a "job done" line appears in out.log
launchctl print gui/$(id -u)/dev.os-cli
launchctl kill SIGKILL gui/$(id -u)/dev.os-cli   # launchd restarts it after ThrottleInterval
```

The agent runs as the logged-in user, never root. For a boot-time daemon, install the plist in `/Library/LaunchDaemons` (owner `root:wheel`, mode 0644) and add `UserName` / `GroupName` of a dedicated unprivileged account; the root guard in `serve` fails closed if that key is forgotten.

The service runs from a copy because `~/Desktop`, `~/Documents` and similar are TCC-protected: a background job reading them gets `EPERM` without Full Disk Access.

On Linux the same job is a systemd unit with `User=`, `Restart=on-failure`, `RestartPreventExitStatus=77 78`, `NoNewPrivileges=yes` and `ReadWritePaths=`; launchd has no equivalent of `RestartPreventExitStatus`, so exits 77/78 retry every 10 s.

## When access is denied

A file the service user cannot read is reported and skipped; the service keeps running:

```console
{"level":"error","msg":"job failed","file":".../locked.txt","pid":26773,"error":{"code":"EACCES","message":"EACCES: permission denied, open '.../locked.txt'"}}
```

A symlink planted in the watched directory is refused instead of followed:

```console
{"level":"error","msg":"job failed","file":".../evil","error":{"code":"ELOOP","message":"ELOOP: too many symbolic links encountered, open '.../evil'"}}
```

Errors that make the service unable to do its job at all are fatal and use the exit code:

```console
$ os-cli serve --config cfg.json        # watchDir is chmod 000
{"level":"error","msg":"EACCES: permission denied, watch '.../locked'","code":"EACCES"}
$ echo $?
77

$ os-cli serve --config cfg.json        # config is chmod 666
{"level":"error","msg":".../cfg.json is group/world-writable (mode 666)","code":"ECONFIG"}
$ echo $?
78
```

A path outside a worker's allowed directories fails with `ERR_ACCESS_DENIED` (covered by `npm test`).

## Limits

- The watcher is non-recursive.
- Ownership/mode checks and `O_NOFOLLOW` are POSIX; the permission model is cross-platform.
- The permission model still follows a symlink that points outside the allowed directory (Node documents this), which is why `O_NOFOLLOW` is also used.
- Only the launchd service is provided.
