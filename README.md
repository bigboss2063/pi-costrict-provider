# pi-costrict-provider

为 Pi 添加原生 CoStrict 提供商，直接连接 CoStrict 服务，不需要运行 costrict-router。

支持浏览器登录、Token 自动续期、动态模型目录、流式文本、函数工具调用，以及模型支持时的图片输入。协议适配参考 [costrict-router](https://github.com/mokeyjay/costrict-router)。

**当前版本：0.1.1。已通过模拟服务测试和 Pi 1.5.0 加载测试，尚未连接真实 CoStrict 实例验证。**

## 要求

- Pi 1.5.0；其他版本尚未验证。
- Node.js 22.19.0 或更高版本。
- 一个兼容本文接口路径的 CoStrict 服务，以及有调用权限的账号。首版针对参考项目使用的私有化部署协议。
- 默认使用 HTTPS；不支持关闭 TLS 证书校验。

## 安装与登录

在项目根目录临时加载：

```sh
pi -e .
```

在 Pi 中执行：

```text
/login costrict
```

1. 输入 CoStrict 服务根地址，例如 `https://costrict.example.com`。不要带 `/v1`、其他路径、查询参数或账号密码。
2. 在浏览器打开显示的登录链接，使用自己的账号完成登录。
3. 返回 Pi 等待确认。登录流程每 3 秒轮询一次，最多等待 5 分钟，可取消；不需要安装 VS Code 或接收其 URI 回调。
4. 打开 `/model`，选择 `costrict` 下的真实模型 ID。

确认可用后，在本项目根目录安装为长期加载的包：

```sh
pi install .
```

重启 Pi；已经运行的会话可执行 `/reload`。开发时修改源码后也需重新加载。

本包尚未发布到 npm。使用 `pi -e .` 或本地路径安装即可，不需要为运行插件执行 `npm install`；宿主 Pi 提供所需依赖。

## 配置

可在启动 Pi 前设置以下环境变量。它们用于**下一次登录**；已登录账号仍使用凭据里保存的实例和客户端参数，避免环境变量变化时将 Token 发往另一个服务。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `COSTRICT_BASE_URL` | 登录时询问 | CoStrict 服务根地址；设置后跳过地址输入 |
| `COSTRICT_PLUGIN_VERSION` | `3.0.23` | 登录参数和请求头中的 CoStrict 扩展版本 |
| `COSTRICT_VSCODE_VERSION` | `1.143.0` | 登录参数中的 VS Code 版本 |
| `COSTRICT_ALLOW_HTTP` | 关闭 | 值为 `1` 时允许非回环地址使用 HTTP |

PowerShell 示例：

```powershell
$env:COSTRICT_BASE_URL = "https://costrict.example.com"
pi -e .
```

仅当管理员明确要求使用可信内网 HTTP 服务时设置 `COSTRICT_ALLOW_HTTP=1`。HTTP 会明文传输凭据和对话。回环地址 `localhost`、`127.0.0.1` 和 `::1` 可用于本地测试。

企业自签名证书应通过 `NODE_EXTRA_CA_CERTS` 配置可信 CA，然后重新启动 Pi。不要使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`。

## 凭据、模型与费用

- 凭据由 Pi 保存在其 agent 目录的 `auth.json`，通常为 `~/.pi/agent/auth.json`。包含 Token、实例地址、用户标识和客户端参数，应按敏感文件保护。插件不会另外写入 Token 文件或普通日志。
- 续期由 Pi 在请求前触发，通常在剩余有效期不足 5 分钟时刷新。Token 轮换由 Pi 的凭据锁串行处理；没有常驻后台续期进程。
- Token 已被服务端撤销或刷新失败时，按错误提示检查网络、权限或重新登录。插件不会把 401 当作限流，也不会自动切换账号。
- 模型目录通过 Pi 的 `models-store.json` 持久化，通常与 `auth.json` 同目录。缓存使用实例地址和用户标识的 SHA-256 校验值隔离，不包含 Token。
- 模型目录缓存 10 分钟；缓存到期后，在联网模式打开 `/model` 可刷新。同一账号刷新失败时保留旧目录，切换账号或实例时不恢复旧目录。
- Pi 启动时先恢复目录缓存。`pi --list-models costrict` 可查看已经缓存的模型；首次使用需要先在交互模式登录并加载目录。
- 服务未提供有效模型限额时，采用 32,768 上下文和 8,192 最大输出的保守默认值。默认不猜测视觉或可控思考能力。
- CoStrict 积分不能直接换算成美元单价。Pi 中费用填零表示**未知，并非免费**；Token 使用量仍按上游返回值记录。
- 注销时执行 `/logout` 并选择 CoStrict。切换实例时重新执行 `/login costrict`。首版同一 Pi agent 目录只保存一个 CoStrict 账号。

可在 Pi 的 `models.json` 中为已发现模型覆盖已确认的限额，例如：

```json
{
  "providers": {
    "costrict": {
      "modelOverrides": {
        "your-real-model-id": {
          "contextWindow": 128000,
          "maxTokens": 16000
        }
      }
    }
  }
}
```

合并到已有配置，不要覆盖其他提供商。不要随意扩大限额，也不要用模型名称推断接口协议。

## 协议与限制

| 用途 | 服务端路径 |
| --- | --- |
| 浏览器登录 | `/oidc-auth/api/v1/plugin/login` |
| 获取或刷新 Token | `/oidc-auth/api/v1/plugin/login/token` |
| 登录状态确认 | `/oidc-auth/api/v1/plugin/login/status` |
| 模型发现 | `/ai-gateway/api/v1/models` |
| 对话 | `/chat-rag/api/v1/chat/completions` |

- 登录使用 CoStrict 插件协议，默认认证来源为 `casdoor`，不是标准 OAuth 授权码交换。
- 请求中的客户端身份字段沿用参考项目的 VS Code/Roo Code 约定，以兼容现有网关。这不代表本插件由 CoStrict 官方提供；这些字段是否必需、是否被当前部署接受，仍需实测。
- 复用 Pi 的 Chat Completions 实现，不提供本地 HTTP 服务，也不实现 Responses、Anthropic Messages 转换。
- 仅支持函数工具。CoStrict 上游专有的联网搜索、文件检索、Computer Use 工具不受支持；Pi 本地工具和扩展工具仍可通过函数调用使用。
- 图片须由模型声明支持，并使用 base64 data URL；不代下载远程图片。
- Pi 可显示上游返回的 `reasoning_content` 等思考内容，但插件默认不发送精确思考力度或预算控制参数。模型默认思考行为由上游决定。
- 按参考项目的兼容策略，DeepSeek、流式 Kimi 和 `auto` 的强制工具选择降级为 `auto`；这些模型在带工具时移除 `response_format`，并按需省略 Kimi/`auto` 的结构化输出温度。GLM 等其他模型不应用这些降级。
- `/compact` 与分支摘要属于一次性总结请求：插件会去掉客户端下发的思考力度参数，并在该路径容忍上游省略 `finish_reason` 的流式结束（日常对话仍要求完整结束块，避免把截断当成成功）。
- 不声明提示词缓存预热支持，不自动替换未知模型。不做多账号调度。
- 认证、模型发现与对话请求均拒绝 HTTP 重定向。应填写最终服务地址，避免凭据或对话被转发到意外位置。

## 开发与验证

```sh
npm ci
npm run check
npm pack --dry-run
npm publish --dry-run
```

`npm publish --dry-run` 只演练发布，不上传包。`prepublishOnly` 会在演练和正式发布前运行类型检查及测试；`publishConfig` 指定发布到 npm 官方仓库，并使用公开访问权限。正式发版走仓库里的 GitHub Actions（推送 `v*` 标签或手动跑 Publish）。

使用 Node 内置测试框架，无需真实账号。测试覆盖登录和取消、Token 轮换、请求头、模型缓存与账号隔离、连续工具调用、思考内容回传、图片、usage、异常流、HTTP 错误和 Pi 包加载。

Pi 加载测试将源码复制到临时目录，不携带本地 `node_modules`，使用独立凭据和模型缓存，再启动真实 Pi CLI 完成模型列表与对话检查；不会读取或修改个人 Pi 配置。

真实服务验收仍需检查：浏览器登录、实际可用模型、多轮工具调用、接近过期时的续期、视觉模型输入、上下文超限和请求取消。遇到部署差异时，请提供脱敏后的 HTTP 状态和响应结构，不要提交 Token 或完整对话。

## 代码位置

- `src/index.ts`：Pi 扩展入口。
- `src/auth.ts`：登录、续期、凭据校验和请求头。
- `src/provider.ts`：Provider 注册、模型发现与缓存。
- `src/request.ts`：CoStrict 模型请求适配。
- `test/`：模拟服务与 Pi 加载测试。

## 许可

MIT。参考项目的版权与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
