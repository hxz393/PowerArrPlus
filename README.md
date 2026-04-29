# PowerArrPlus

PowerArrPlus 是一个给 Prowlarr 补充搜索结果管理能力的小工具。当前主要功能是 **Prowlarr Seen Result Filter**：在 Prowlarr 搜索页勾选 release，把它们记录到 Redis，之后再次搜索时自动过滤这些已处理过的结果。

项目由两部分组成：

- 一个 Redis-backed Python HTTP 服务，负责保存和查询已隐藏 release。
- 一个 Tampermonkey 用户脚本，注入到 Prowlarr 搜索页，提供工具条和搜索结果过滤逻辑。

## 功能

- 在 Prowlarr 搜索页增加 `Seen Filter` 工具条。
- 复用 Prowlarr 原生搜索结果选择框，支持 `隐藏选中` 和 `隐藏本页`。
- 点击隐藏后只写入记录，不自动重新搜索，避免浪费索引器调用额度。
- 下次手动搜索时过滤已隐藏 release。
- `取消本页已隐藏` 只恢复当前搜索结果里被隐藏的 release，不清空其他搜索页的隐藏记录。
- 对 NZB/Usenet 结果做严格去重：`title + size + files` 完全一致时，只展示抓取数最高的结果。
- Redis 只保存 release 指纹和少量摘要信息，不保存 Prowlarr API key 或下载链接。

## 工作方式

用户脚本会拦截 Prowlarr 搜索接口 `/api/v1/search` 的响应，把 release 列表交给本地服务检查。服务返回未隐藏的 release，用户脚本再在浏览器里执行严格去重，并把过滤后的结果交还给 Prowlarr 前端渲染。

隐藏动作写入 Redis；恢复动作只删除当前搜索页相关的指纹。页面上的过滤与去重互相独立：手动隐藏是持久状态，严格去重只作用于当前搜索响应。

## 需求

- Prowlarr
- Redis
- Docker Compose，推荐用于部署后端服务
- Tampermonkey 或兼容的 userscript 管理器

## 后端部署

克隆仓库：

```bash
git clone https://github.com/hxz393/PowerArrPlus.git
cd PowerArrPlus
```

复制环境变量模板：

```bash
cp .env.example .env
```

编辑 `.env`。如果 Redis 跑在同一台 Docker 主机并映射了 `6379` 端口，默认值通常可用：

```env
POWERARR_PLUS_PORT=17896
POWERARR_PLUS_REDIS_HOST=host.docker.internal
POWERARR_PLUS_REDIS_PORT=6379
POWERARR_PLUS_KEY_PREFIX=powerarr_plus:prowlarr_seen_filter
POWERARR_PLUS_ALLOW_ORIGIN=*
```

启动服务：

```bash
docker compose up -d --build
```

检查状态：

```bash
curl -sS http://127.0.0.1:17896/health
```

期望返回：

```json
{"ok": true, "redis": "PONG"}
```

如果后端部署在另一台机器，确认浏览器所在机器可以访问：

```bash
curl -sS http://<backend-host>:17896/health
```

## 安装用户脚本

安装 Tampermonkey 后，新建脚本并复制：

```text
userscripts/prowlarr_seen_filter.user.js
```

也可以从 GitHub raw 页面安装或复制：

```text
https://raw.githubusercontent.com/hxz393/PowerArrPlus/main/userscripts/prowlarr_seen_filter.user.js
```

用户脚本默认会把服务地址推断为：

- Prowlarr 页面是 `http://localhost:9696` 或 `http://127.0.0.1:9696` 时，使用 `http://127.0.0.1:17896`
- Prowlarr 页面是 `http://<host>:9696` 时，使用 `http://<host>:17896`

脚本默认匹配 `9696` 端口。如果你的 Prowlarr 通过反向代理暴露在其他路径或端口，需要在脚本头部增加对应的 `@match` 或 `@include`。

如果后端服务不在同一台机器，打开 Prowlarr 页面后，在浏览器控制台设置：

```javascript
localStorage.setItem("powerarrPlusServiceOrigin", "http://<backend-host>:17896");
```

需要恢复默认推断时：

```javascript
localStorage.removeItem("powerarrPlusServiceOrigin");
```

## 使用

1. 打开 Prowlarr 搜索页。
2. 正常搜索。
3. 在结果列表左侧勾选不想再看到的 release。
4. 点击 `隐藏选中`。
5. 下次手动搜索时，这些 release 会被过滤。

按钮说明：

- `隐藏选中`：隐藏当前勾选的结果；如果选中结果属于严格去重组，会把同组重复项一起隐藏。
- `隐藏本页`：隐藏当前搜索页可见的全部结果。
- `取消本页已隐藏`：恢复当前搜索页中被过滤服务隐藏的结果；不会影响其他搜索页或其他关键词的隐藏记录。

## 配置

后端环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `POWERARR_PLUS_BIND` | `127.0.0.1` | HTTP 服务监听地址；Docker Compose 中固定为 `0.0.0.0` |
| `POWERARR_PLUS_PORT` | `17896` | HTTP 服务端口 |
| `POWERARR_PLUS_REDIS_HOST` | `127.0.0.1` | Redis 主机；Docker Compose 示例默认使用 `host.docker.internal` |
| `POWERARR_PLUS_REDIS_PORT` | `6379` | Redis 端口 |
| `POWERARR_PLUS_KEY_PREFIX` | `powerarr_plus:prowlarr_seen_filter` | Redis key 前缀 |
| `POWERARR_PLUS_ALLOW_ORIGIN` | `*` | CORS `Access-Control-Allow-Origin` |

## Redis 数据

默认 key：

```text
powerarr_plus:prowlarr_seen_filter:hidden:v1
powerarr_plus:prowlarr_seen_filter:meta:v1:<fingerprint>
```

release 指纹优先级：

1. `infoHash`
2. `indexerId + guid`
3. `indexerId + releaseHash`
4. `indexerId + infoUrl`，会去掉 `apikey`、`token` 等敏感 query 参数
5. `indexerId + normalized(title) + size`

## 去重规则

去重只在当前搜索结果里生效，不会写入 Redis。只有满足以下条件才视为同一个 NZB/Usenet release：

```text
protocol 是 NZB/Usenet
title 完全一致，仅 trim、Unicode NFC、HTML entity 还原
size 完全一致
files 完全一致
```

同组只展示 `grabs` 最大的一条。`files` 缺失时不参与去重。

规则故意偏严格。很多看起来相似的发布，实际可能是不同打包或不同内容结构；保留下来能避免误杀仍可下载的备选源。

## 本地开发

创建虚拟环境并安装：

```bash
git clone https://github.com/hxz393/PowerArrPlus.git
cd PowerArrPlus
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

Windows PowerShell 激活虚拟环境：

```powershell
.\.venv\Scripts\Activate.ps1
pip install -e .
```

启动后端：

```bash
POWERARR_PLUS_REDIS_HOST=127.0.0.1 powerarr-plus-seen-filter
```

Windows PowerShell：

```powershell
$env:POWERARR_PLUS_REDIS_HOST = "127.0.0.1"
powerarr-plus-seen-filter
```

也可以使用项目提供的 Windows 启动脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-powerarr-plus.ps1
```

## 测试

Python 单元测试：

```bash
PYTHONPATH=src python -m unittest discover -s tests
```

Windows PowerShell：

```powershell
$env:PYTHONPATH = "src"
python -m unittest discover -s tests
```

浏览器 harness 冒烟测试：

```bash
node tests/browser_harness_smoke.js
```

手工打开 harness：

```bash
python -m http.server 18080 --bind 127.0.0.1
```

然后访问：

```text
http://127.0.0.1:18080/tests/browser_harness.html
```

真实 Prowlarr 冒烟测试会触发一次真实搜索请求，可能消耗索引器额度：

```bash
node tests/real_prowlarr_smoke.js
```

检查真实搜索结果的去重依据：

```bash
node tests/probe_real_duplicates.js
```

需要输出 indexer 详情 URL 时：

```bash
SHOW_GUIDS=1 node tests/probe_real_duplicates.js
```

## 注意事项

- 用户脚本必须能访问 PowerArrPlus 后端服务地址。
- 如果浏览器页面是 HTTPS，而后端是 HTTP，浏览器可能拦截混合内容；建议让 Prowlarr 与 PowerArrPlus 使用同一协议，或在反向代理后统一暴露。
- `POWERARR_PLUS_ALLOW_ORIGIN=*` 方便局域网使用；公开暴露到互联网前应收紧来源并加反向代理鉴权。
- 当前项目不负责下载或抓取 NZB，只过滤 Prowlarr 搜索结果展示。
