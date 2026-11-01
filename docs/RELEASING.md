# 发版流程（RELEASING）

目标：从「改完代码」到「GitHub 上有一个带安装包的 Release」，每一步都能重放。

> 这份文档的命令以 Windows + PowerShell 为例；macOS / Linux 把 `Compress-Archive` 换成 `zip -r` 即可。

---

## 0. 前置检查

```powershell
cd <仓库目录>
git status                 # 应该是干净的（或只剩你本次的改动）
git branch --show-current  # 应该是 main
node -v                    # >= 22.13
```

> **本机注意**：这台机器的 git 走 OpenSSL 后端且缺 CA，push 时要加 `-c http.sslVerify=false`。

---

## 1. 定版本号

改 `package.json` 的 `version`（语义化版本）：

| 改了什么 | 版本 |
|---|---|
| 只修 bug | patch（0.2.0 → 0.2.1） |
| 加功能，向后兼容 | minor（0.2.0 → 0.3.0） |
| 破坏性变更（比如改配置结构、改工具名） | major |

**版本号必须和后面的 git tag 一致**，否则 `build-release` 打出来的目录名会对不上。

---

## 2. 跑测试

```powershell
node tests/memory.test.mjs     # 单元测试（当前 10 个）
node scripts/selftest.mjs      # 端到端：拉起 MCP server 验工具与信任行为
```

两个都过再往下。CI 也会跑，但别把 CI 当第一道关卡。

---

## 3. 打发布包

```powershell
node scripts/build-release.mjs
```

如果本机 `pnpm` 不在 PATH（比如用的是 DSH 自带的那个），显式指一下：

```powershell
node scripts/build-release.mjs --pnpm "C:\path\to\pnpm\bin\pnpm.mjs"
```

产物：`dist/dsh-reef-v<version>/`（约 16 MB，含依赖）。

脚本会：

1. 复制 `src/ scripts/ docs/ examples/ tests/ README LICENSE config.example.json`
2. 用 `--node-linker=hoisted` **重新装一份干净依赖**（不含 devDependencies）
3. 生成 `安装说明.txt` 和 `安装.cmd`

> **为什么不用开发目录的 node_modules**：pnpm 默认（isolated）在 `node_modules/` 顶层放符号链接，
> 复制/压缩工具对链接处理不一致，结果是包里少了依赖、用户装完报 `ERR_MODULE_NOT_FOUND`。
> hoisted 模式产出真实目录，复制不会丢。

---

## 4. 装到临时目录验证（关键一步）

**不要**只信打包成功，要在干净目录里真的装一遍：

```powershell
$tmp = "$env:TEMP\reef-verify"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$tmp\dsh\profiles\desktop" | Out-Null

Push-Location "dist\dsh-reef-v0.2.0"
node scripts\install-wizard.mjs --yes --dsh-home "$tmp\dsh" --install-dir "$tmp\install" --memory-dir "$tmp\mem"
Pop-Location

Push-Location "$tmp\install"
node scripts\selftest.mjs        # 期望：全部通过 ✓
node src\panel\server.mjs --port 3213
```

面板启动后浏览器打开 `http://127.0.0.1:3213/?token=<打印出来的>`，能出页面就说明静态资源也打进去了。

验证完删掉 `$tmp`。

---

## 5. 压缩

```powershell
Compress-Archive -Path "dist\dsh-reef-v0.2.0" -DestinationPath "dist\dsh-reef-v0.2.0-win.zip" -Force
```

检查一下大小（正常 5–6 MB）和哈希（发完要用来核对上传）：

```powershell
Get-Item "dist\dsh-reef-v0.2.0-win.zip" | Select-Object Name,Length
(Get-FileHash "dist\dsh-reef-v0.2.0-win.zip" -Algorithm SHA256).Hash
```

---

## 6. 提交并打 tag

```powershell
git add -A
git commit -m "feat: 0.2.0 —— 一句话说清这版加了什么"

git tag -a v0.2.0 -m "v0.2.0 — 标题

- 要点一
- 要点二"

git -c http.sslVerify=false push
git -c http.sslVerify=false push origin v0.2.0
```

> `-a` 是附注标签（annotated），带作者、时间、说明；`git tag` 不带 `-a` 是轻量标签，信息少一半。
> 版本发布一律用 `-a`。

---

## 7. 建 Release + 上传安装包

### 方式 A：网页（最稳）

1. 打开 `https://github.com/<你>/dsh-reef/releases/new`
2. 选刚推上去的 tag `v0.2.0`
3. 标题 `v0.2.0 — <一句话>`，正文写变更（结构建议：新增 / 修复 / 安装包内容 / 卸载）
4. 下方 **Attach binaries** 把 `dist\dsh-reef-v0.2.0-win.zip` 拖进去
5. Publish release

### 方式 B：API（可脚本化）

```python
# 需要 PAT（classic，勾 repo）。令牌可从 Git Credential Manager 里取：
#   git credential fill  → 输出的 password 就是 token
import json, os, urllib.request
TOKEN = os.environ['GH_TOKEN']; REPO = 'BluePIEcom/dsh-reef'
rel = json.load(urllib.request.urlopen(urllib.request.Request(
    f'https://api.github.com/repos/{REPO}/releases',
    data=json.dumps({'tag_name': 'v0.2.0', 'name': 'v0.2.0 — 标题',
                     'body': '变更说明', 'draft': False, 'prerelease': False}).encode(),
    headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json',
             'Accept': 'application/vnd.github+json'}, method='POST')))
data = open(r'dist\dsh-reef-v0.2.0-win.zip', 'rb').read()
urllib.request.urlopen(urllib.request.Request(
    f"https://uploads.github.com/repos/{REPO}/releases/{rel['id']}/assets?name=dsh-reef-v0.2.0-win.zip",
    data=data, headers={'Authorization': f'Bearer {TOKEN}',
                        'Content-Type': 'application/zip'}, method='POST'))
```

---

## 8. 发完核对

1. Release 页面能看到 zip，大小对得上
2. 下载一次，比对哈希与本地一致
3. 在**另一台没装过**的机器上（或删掉重装的临时目录）双击 `安装.cmd` 走一遍

---

## 9. 常见坑

| 现象 | 原因 / 解法 |
|---|---|
| 用户装完报 `ERR_MODULE_NOT_FOUND` | 打包把符号链接复制丢了。确认 `build-release` 用的是 hoisted 安装，且 copy 用 `statSync` 跟随链接 |
| 依赖在，但包内 `dist/` 目录丢了 | 复制时按名字跳过 `dist` 会把依赖包自己的 `dist/` 一起跳。只跳过**包根目录**下的 `dist` |
| `安装.cmd` 双击闪退 | 没装 Node，或 Node < 22；脚本里有 `where node` 检查，看它打印什么 |
| PowerShell 脚本报「缺少 `}`」 | `.ps1` 存成了 **UTF-8 无 BOM**，PS 5.1 按 ANSI 读中文就崩。用「UTF-8 带 BOM」保存 |
| `git push` 报证书错误 | 本机 OpenSSL 缺 CA：`git -c http.sslVerify=false push` |
| Release 上传 422 | 同名资源已存在，或 tag 已绑定别的 release；先删旧资源/旧 release |
| 版本对不上 | `package.json` 的 version ≠ tag。改完重打 tag（删本地与远端旧 tag 再推） |

---

## 10. 回滚

```powershell
# 删远端 tag
git -c http.sslVerify=false push --delete origin v0.2.0
# 删本地 tag
git tag -d v0.2.0
# Release：网页上 Delete release（可勾选同时删除 tag）
```

如果只是安装包打错了、代码没问题：**删掉 release 里的那个 asset 重新上传**，不用动 tag。
