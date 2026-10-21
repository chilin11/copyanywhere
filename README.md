# CopyAnywhere

自托管、**端到端加密**的跨设备剪贴板 / 文件传输。手机、Mac、Windows 各开一个网页，不在同一个网络也能互传文字、截图和文件。

- **服务器看不到内容**：内容在浏览器里用 AES-256-GCM 加密后才上传。密钥只存在于配对链接的 `#` 片段和各设备本地，浏览器不会把 `#` 后面的部分发给服务器。文件名、类型、设备名也一起加密。
- **任何网络都能用**：只需要能访问你的域名（HTTPS），不需要 TURN、不需要客户端。
- **大文件**：8MB 分块加密、3 路并行上传，失败自动重试，下载时边收边解密。单次请求不超过 17MB，所以经过 Cloudflare（免费版 100MB 上限）也能传几 GB 的文件。
- **总容量 5GB**：所有空间合计不超过 `MAX_TOTAL_MB`，满了自动删除最旧的内容；同时检查磁盘剩余空间。
- **用完即焚**：默认 24 小时后自动删除；可以手动删除单条、清空，或删除整个空间。
- **零依赖**：Node 内置模块，一个容器，以非 root 用户运行，根文件系统只读。

## 部署（VPS + cloudflared）

需要 Docker（含 Compose v2）和一个托管在 Cloudflare 的域名。不需要开放任何入站端口。

```bash
git clone <this repo> copyanywhere && cd copyanywhere
./install.sh
```

脚本会生成 `.env`（包含随机的服务器密码），构建并启动容器，最后打印密码。服务只监听 `127.0.0.1:8090`，HTTPS 交给 cloudflared，按你的情况选一种：

| 情况 | 做法 | Public Hostname 的 Service |
|---|---|---|
| VPS 上已经装了 cloudflared（systemd） | Zero Trust → Networks → Tunnels → 你的隧道 → Public Hostname → 添加域名 | `http://127.0.0.1:8090` |
| 用本地配置文件 `config.yml` | 在 `ingress` 里加 `- hostname: drop.example.com` / `service: http://127.0.0.1:8090`，然后重启 cloudflared | 同上 |
| 还没有 cloudflared | 在 Zero Trust 新建 Tunnel（选 Docker），把 token 填进 `.env` 的 `TUNNEL_TOKEN`，再运行一次 `./install.sh`，会一并启动 cloudflared 容器 | `http://copyanywhere:8080` |
| cloudflared 跑在另一个 Docker 容器里 | `.env` 设 `BIND_HOST=172.17.0.1`（docker0 网桥地址），重新 `./install.sh` | `http://172.17.0.1:8090` |

- **更新**：`git pull && ./install.sh`
- **日志**：`docker compose logs -f`
- **配置**（`.env`）：`TTL_HOURS` 保存时长、`MAX_TOTAL_MB` 总容量（默认 5120）、`MAX_FILE_MB` 单文件上限（默认等于总容量）、`MAX_ITEMS` 每个空间条数、`MIN_FREE_MB` 磁盘保留空间。改完重新运行 `./install.sh`。

> 不要在 Cloudflare 上给这个域名开 Rocket Loader / 自动压缩 JS 一类会改写页面的功能，它们会被 CSP 拦下。

## 使用

1. 电脑打开 `https://drop.example.com`，输入服务器密码，**创建空间**。
2. 弹出二维码后，手机扫码即可加入。其他电脑可以把「复制链接」发给自己，然后打开。之后随时点右上角 **＋** 再添加设备。
3. 之后在任一设备上：
   - **发送**：在页面任意位置按 Ctrl/⌘+V，粘贴的文字、截图、文件会直接加密发送；也可以拖拽文件，或者点「粘贴」「文件」。电脑上 Enter 发送，Shift+Enter 换行。
   - **接收**：内容实时出现，点「复制」「复制图片」「下载」即可。图片点开看大图，视频 / 音频可以直接播放。可以开「收到文字自动复制」（设置里，需要页面在前台）。
   - 顶部可以按 文字 / 图片 / 文件 筛选，底部显示服务器已用容量。
4. **Android**：在 Chrome 里把网页「添加到主屏幕」。之后在相册、文件或任意 App 里点「分享 → CopyAnywhere」，就能直接发送。
5. **iPhone**：Safari 里点「添加到主屏幕」。iOS 不支持网页出现在分享菜单里，所以要打开它，再点「粘贴」或「文件」。

> 手机系统不允许网页或 App 在后台读取剪贴板，所以「复制完别的设备自动就有」只能在发出方手动点一次发送，任何工具都绕不开这一点。

## 安全模型

| 谁 | 能看到什么 |
|---|---|
| VPS / 服务器管理员 / Cloudflare | 只有密文、密文大小、上传时间。看不到内容、文件名、设备名，也拿不到密钥 |
| 拿到配对链接的人 | 能看到这个空间里的全部内容。**链接就是钥匙，只发给自己的设备** |
| 不知道服务器密码的人 | 不能创建空间（密码错误 10 次 / 15 分钟后会被限流） |

- 空间 ID 由密钥经 HKDF 单向派生，服务器无法反推出密钥。
- 每条内容、每个分块都用独立的随机 IV；分块的 AAD 绑定了条目、序号和「是否最后一块」，调换顺序、替换或截断都会解密失败。
- 严格的 CSP（禁止内联脚本、只允许同源连接）、`Referrer-Policy: no-referrer`，服务器不记录访问日志。
- 网页端加密有一个固有前提：你要信任服务器发下来的 JS。因为服务器是你自己的，这一点成立。Cloudflare 终止 TLS，但它拿到的也只是密文和这份 JS。
- 想让某台设备失效：在那台设备上点「退出」；如果怀疑链接已经泄露，就「删除整个空间」，再重新创建一个。

## 开发

```bash
npm run dev    # PASSWORD=dev，http://localhost:8080
npm test       # API + 加密测试
```

二维码库 `public/vendor/qrcode.mjs` 来自 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT）。
