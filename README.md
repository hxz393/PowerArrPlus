# PowerArrPlus

PowerArrPlus 是一个给 Prowlarr 等 Arr 工具补功能的本地伴随项目。当前第一项功能是 **Prowlarr Seen Result Filter**：在 Prowlarr 搜索页勾选结果并隐藏，后续搜索时自动过滤掉这些已隐藏 release。

## 功能

- 在 Prowlarr 搜索页的 `Donate` 按钮左侧增加 `Seen Filter` 工具条；找不到该按钮时才回退到右下角。
- 直接读取 Prowlarr 搜索结果左侧自带的选择框，勾选后写入 Redis。
- 下次搜索时观察 `/api/v1/search` 的 `fetch`/XHR 结果，隐藏已记录 release。
- 默认只绑定 `127.0.0.1`，不暴露到局域网。
- Redis 里只保存指纹和少量摘要元数据，不保存 Prowlarr API key 或下载链接。

## 目录

```text
PowerArrPlus/
  src/powerarr_plus/seen_filter_service.py   本地 HTTP + Redis 服务
  userscripts/prowlarr_seen_filter.user.js   Tampermonkey 脚本
  scripts/start-powerarr-plus.ps1            Windows 启动脚本
  tests/test_seen_filter.py                  指纹和 URL 规则测试
```

## 快速启动

默认配置：

- Prowlarr: `http://localhost:9696`
- 本地过滤服务: `http://127.0.0.1:17896`
- Redis: `192.168.2.204:6379`

启动服务：

```powershell
powershell -ExecutionPolicy Bypass -File D:\Software\Programming\Python\PowerArrPlus\scripts\start-powerarr-plus.ps1
```

健康检查：

```powershell
curl.exe http://127.0.0.1:17896/health
```

期望返回：

```json
{"ok": true, "redis": "PONG"}
```

## 安装油猴脚本

在 Tampermonkey 里新建脚本，把这个文件内容放进去：

```text
D:\Software\Programming\Python\PowerArrPlus\userscripts\prowlarr_seen_filter.user.js
```

然后打开：

```text
http://localhost:9696/search
```

搜索后顶部 `Donate` 左侧会出现 `Seen Filter` 工具条。勾选结果后点 `隐藏选中`，再次搜索时这些结果会被隐藏。

## 配置

服务端环境变量：

| 变量 | 默认值 |
| --- | --- |
| `POWERARR_PLUS_BIND` | `127.0.0.1` |
| `POWERARR_PLUS_PORT` | `17896` |
| `POWERARR_PLUS_REDIS_HOST` | `192.168.2.204` |
| `POWERARR_PLUS_REDIS_PORT` | `6379` |
| `POWERARR_PLUS_KEY_PREFIX` | `powerarr_plus:prowlarr_seen_filter` |
| `POWERARR_PLUS_ALLOW_ORIGIN` | `*` |

油猴脚本里的服务地址默认是 `http://127.0.0.1:17896`。如需临时改地址，可以在 Prowlarr 页面控制台执行：

```javascript
localStorage.setItem("powerarrPlusServiceOrigin", "http://127.0.0.1:17896");
```

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

## 测试

```powershell
cd D:\Software\Programming\Python\PowerArrPlus
$env:PYTHONPATH = "src"
python -m unittest discover -s tests
```

浏览器冒烟测试：

```powershell
cd D:\Software\Programming\Python\PowerArrPlus
python -m http.server 18080 --bind 127.0.0.1
```

然后打开：

```text
http://127.0.0.1:18080/tests/browser_harness.html
```

该页面会加载同一份 `userscripts/prowlarr_seen_filter.user.js`，用 XHR 模拟 Prowlarr 搜索结果和左侧原生选择框，用来检查工具条、勾选框和 `隐藏选中` 流程是否会卡住页面。
