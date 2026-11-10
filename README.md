# CopyAnywhere

自托管、**端到端加密**的跨设备剪贴板 / 文件传输。手机、Mac、Windows 各开一个网页，不在同一个网络也能互传文字、截图和文件。

- **服务器看不到内容**：内容在浏览器里用 AES-256-GCM 加密后才上传。Token 是加密密钥，只存于各设备本地和配对链接的 `#` 片段；浏览器不会把 `#` 后面的部分发给服务器。文件名、类型、设备名也一起加密。
- **任何网络都能用**：只需要能访问你的域名（HTTPS），不需要 TURN、不需要客户端。
- **大文件**：8MB 分块加密上传，支持续传和自动重试，下载时边收边解密。单次请求不超过 17MB，所以经过有请求体大小限制的隧道 / CDN（如 Cloudflare 免费版 100MB）也能传几 GB 的文件。
- **总容量 5GB**：所有空间合计不超过 `MAX_TOTAL_MB`，满了自动删除最旧的内容；同时检查磁盘剩余空间。
- **用完即焚**：默认 24 小时后自动删除；可以手动删除单条、清空，或删除整个空间。
- **零依赖、很轻**：只需要 Node.js，没有 npm 依赖、不需要 Docker。运行时约 75MB 内存，以独立的非 root 用户运行。

## 部署（不需要 Docker）

需要一台 Linux VPS（systemd 或 Alpine/OpenRC，x86_64 / arm64 / armv7）和一个已经能用 HTTPS 访问到这台 VPS 的域名（你自己的隧道或反代）。浏览器加密接口要求 HTTPS。

在 VPS 上运行这一条命令（以后再运行同一条就是更新，配置、密码和数据都保留）：

```bash
curl -fsSL https://raw.githubusercontent.com/chilin11/copyanywhere/main/install.sh | sudo sh
```

> 已经是 root 登录就去掉 `sudo`；系统没有 curl 就把 `curl -fsSL` 换成 `wget -qO-`。


脚本会：
- 系统已有 Node.js 20+ 就直接用；没有的话 Alpine 用 apk 装，其他系统从 nodejs.org 下载官方二进制（只装 `node` 一个文件，校验 sha256）到 `/opt/copyanywhere/node`；
- 创建系统用户 `copyanywhere`，程序在 `/opt/copyanywhere`，数据在 `/var/lib/copyanywhere`，配置在 `/etc/copyanywhere/env`（含随机服务器密码）；
- 注册 systemd / OpenRC 服务（开机自启、崩溃自动重启、systemd 下带沙箱限制），只监听 `127.0.0.1:8090`；
- 磁盘不够 5GB 时自动把存储上限调小（给系统留 1GB）。

服务只监听本机 **`127.0.0.1:8090`**，把你的域名（隧道 / 反代，需要 HTTPS）指向这个地址即可。

- **更新**：再运行一次上面的安装命令。
- **换端口**：`… | sudo sh -s -- --port 8091`
- **状态 / 日志**：`systemctl status copyanywhere` / `journalctl -u copyanywhere -f`（Alpine：`rc-service copyanywhere status` / `/var/log/copyanywhere.log`）
- **配置**（`/etc/copyanywhere/env`）：`TTL_HOURS` 保存时长、`MAX_TOTAL_MB` 总容量（默认 5120）、`MAX_FILE_MB` 单文件上限（默认等于总容量）、`MAX_ITEMS` 每个空间条数、`MIN_FREE_MB` 磁盘保留空间。改完 `systemctl restart copyanywhere`。
- **卸载**：`… | sudo sh -s -- --uninstall`（保留数据）；`--uninstall --purge` 连数据、配置一起删。

> VPS 访问不了 GitHub 时：在电脑上 `npm run bundle` 生成带程序文件的单文件 `dist/install.sh`，上传后 `sudo sh install.sh`。也可以 `git clone` 后在项目目录里运行 `sudo sh install.sh`。
> 有 Docker 的机器可以用 `./install-docker.sh`（见 `docker-compose.yml`、`.env.example`）。

> 如果域名经过 Cloudflare 代理，不要开 Rocket Loader / 自动压缩 JS 一类会改写页面的功能，它们会被 CSP 拦下。

## 用 Token 连接设备

没有账号，也不用每次登录。**在同一服务器上使用相同 Token 的设备共享内容**；不同服务器即使用相同 Token，也不会自动互相同步。

- **Token 等同私钥**：它是原有的 43 字符随机密钥，不是服务器创建密码。拿到 Token 或含它的配对链接的人可以访问并解密对应内容；二维码也包含 Token，只发给自己的设备，勿公开展示或发送给不信任的人。
- **服务器创建密码**：安装时随机生成，打印在安装输出最后，也保存在 `/etc/copyanywhere/env` 的 `PASSWORD=`（`sudo grep PASSWORD /etc/copyanywhere/env` 查看）。它只用于在服务器上创建新连接，不用于加入已有连接，也不是 Token。修改后执行 `systemctl restart copyanywhere`，已有连接不受影响。
- 创建后，在「添加设备」中扫码、复制 Token 或复制配对链接；其他设备在同一服务器首屏粘贴 Token 或原来的同源 `#s=` 链接，也可以打开链接。旧设备保存的密钥和旧链接仍然可用。
- 每台设备会记住 Token；设置中的「更换 Token」会先验证目标并要求确认。切换会替换本机保存的 Token，但不会删除原服务器数据；请事先安全备份原 Token 或链接，否则可能无法找回。「本设备退出」只移除本机 Token。

## 使用

1. 电脑打开你的域名，输入服务器创建密码，**创建并连接**，系统会生成新的 Token。
2. 弹出二维码后，手机扫码即可加入。也可点「复制 Token」或「复制链接」，在同一服务器的其他设备首屏粘贴。之后随时点右上角 **＋** 再添加设备。
3. 之后在任一设备上：
   - **发送**：在页面任意位置按 Ctrl/⌘+V，粘贴的文字、截图、文件会直接加密发送；也可以拖拽文件，或者点「粘贴」「文件」。电脑上 Enter 发送，Shift+Enter 换行。
   - **接收**：内容实时出现，点「复制」「复制图片」「下载」即可。图片点开看大图，视频 / 音频可以直接播放。可以开「收到文字自动复制」（设置里，需要页面在前台）。
   - 顶部可以按 文字 / 图片 / 文件 筛选，底部显示服务器已用容量。
4. **Android**：在 Chrome 里把网页「添加到主屏幕」。之后在相册、文件或任意 App 里点「分享 → CopyAnywhere」，就能直接发送。
5. **iPhone**：Safari 里点「添加到主屏幕」。主屏幕应用和 Safari 可能使用不同的本地存储；如果首次打开没有连接，请在已加入的设备复制 Token 或配对链接，在首屏粘贴加入。iOS 不支持网页出现在分享菜单里，所以要打开它，再点「粘贴」或「文件」。

顶部的短指纹只是核对提示，不是完整 Token；指纹相同也不能证明 Token 相同，更不能证明服务器相同。设备数是实时连接的近似值。点「自查」可查看连接状态和复制不含 Token 的诊断信息。轮询同步表示实时通道可能不可用；检查反向代理是否缓冲 SSE。服务器明确报告当前 Token 对应的连接不存在时，本机 Token 会保留，直到用户选择移除或替换。

> 手机系统不允许网页或 App 在后台读取剪贴板，所以「复制完别的设备自动就有」只能在发出方手动点一次发送，任何工具都绕不开这一点。

## 安全模型

| 谁 | 能看到什么 |
|---|---|
| VPS / 服务器管理员 / 隧道或反代 | 只有密文、密文大小、上传时间。看不到内容、文件名、设备名，也拿不到密钥 |
| 拿到 Token 或配对链接的人 | 能访问并解密对应内容。**Token 和链接只发给自己的设备** |
| 不知道服务器密码的人 | 不能创建空间（密码错误 10 次 / 15 分钟后会被限流） |

- 空间 ID 由密钥经 HKDF 单向派生，服务器无法反推出密钥。
- 每条内容、每个分块都用独立的随机 IV；分块的 AAD 绑定了条目、序号和「是否最后一块」，调换顺序、替换或截断都会解密失败。
- 严格的 CSP（禁止内联脚本、只允许同源连接）、`Referrer-Policy: no-referrer`，应用不记录访问日志。事件日志默认关闭；需要排障时可在服务环境设置 `LOG_LEVEL=info`（事件及空间 ID 前六位等），排障后改回 `LOG_LEVEL=silent`。反代或隧道可能有独立的访问日志。
- 网页端加密有一个固有前提：你要信任服务器发下来的 JS。因为服务器是你自己的，这一点成立。前面的隧道 / 反代即使终止 TLS，拿到的也只是密文和这份 JS。
- 想让某台设备退出：在那台设备上点「本设备退出」（如果它已复制 Token，仍可重新连接）；如果怀疑 Token 或链接已经泄露，就「删除当前连接及内容」，再创建新 Token，并在自己的设备重新连接。此删除会立即删除旧连接的服务器密文。

## 开发

```bash
npm run dev    # PASSWORD=dev，http://localhost:8080
npm test       # API + 加密测试
```

二维码库 `public/vendor/qrcode.mjs` 来自 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT）。
