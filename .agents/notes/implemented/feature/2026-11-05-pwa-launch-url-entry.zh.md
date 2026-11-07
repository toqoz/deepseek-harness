# Agent Note: 有効なセッションが無いブラウザに起動 URL を入力させる

Status: implemented

[English](2026-11-05-pwa-launch-url-entry.md) | 中文

## 问题

`dsh web` 启动时生成一次性的启动令牌，并打印带该令牌的应用 URL。持有有效会话 cookie 的浏览器不再需要该 URL，但当 cookie 缺失、过期或绑定到其他 authority 时，该 URL 是唯一的入口。

cookie、其 authority 绑定和令牌交换由[浏览器启动令牌认证](../architecture/2026-08-24-browser-token-authentication.zh.md)负责。

安装到主屏幕的 Web 应用没有地址栏，且其启动 URL 在安装时固定。这样的应用未认证地启动时，操作者没有任何可以粘贴已打印 URL 的界面，而 Host 原先的纯文本 401 也没有提供输入位置。

同一次启动还有浏览器层面的问题，使只有表单的页面不够用：独立启动可能不携带 `SameSite=Strict` 的浏览器 cookie，即使同一 profile 中持有有效 cookie；而由 401 文档自身发起的导航会携带它。对于一个已经保存的令牌仍要求输入，看起来就是登录损坏。

## 决策

`BrowserAuth.writeUnauthorized` 以自包含的 HTML 页面代替纯文本：无框架、无外部资源、一段内联脚本和一段内联样式，`default-src 'none'` 的 CSP 仅放行内联样式与脚本，`base-uri 'none'`、`frame-ancestors 'none'`、`nosniff`、`no-referrer`、`cache-control: no-store`。`HEAD` 保持相同响应头且无 body。

页面提供以 `window.location.href` 预填的 URL 输入框。提交只接受 `http:` 与 `https:`，并赋值给 `window.location.href`，令牌因此在该 URL 自身的 authority 上换取 cookie；其他 authority 的 URL 只认证那个 authority，而不是应用本身。

在表单可用之前，页面会自行重载一次，由一个 `sessionStorage` 中的时间戳和五秒窗口守护。重试的导航由文档发起，因此不携带 cookie 的独立启动会得到已认证的加载结果。窗口内的第二次 401 显示表单，使真正未认证的访问只多一次请求且不形成循环。存储不可用时表单是唯一途径。

## 备选方案

**把 cookie 放宽为 `SameSite=Lax`。** Lax cookie 会随顶层 `GET` 导航发送，因此启动时无需任何客户端步骤即可认证。它被否决，因为这会为所有部署改变一条有意的安全规则，包括从不安装该应用的部署，只为补偿某个浏览器的启动处理。重试方案保持 cookie 为 Strict，并把变通限制在未认证页面内。

**始终显示表单。** 这是既有行为加上更好的呈现，且仍会向操作者索要一个已经存在但未被附上的令牌。它造成的失败——在可用会话上弹出登录框——正是要消除的那一种。

**在浏览器中记住上次成功的 URL。** 令牌属于某一次 `dsh web` 进程，因此记住的 URL 在下一次重启后就已失效。失效令牌还会以带令牌请求的形式到达 `authorizeIndex`，而这正是本页面要避免的路径。

**跳转到固定的登录路由。** 接受粘贴令牌的路由仍然必须渲染输入框，而未认证的 index 响应是 Host 在认证前提供的唯一文档。单独的路由会复制该页面及其响应头。

## 后果

没有地址栏的操作者可以恢复会话，而 cookie 被扣留的 PWA 启动现在无需交互即可加载。每次未认证访问多一次请求；`no-store` 使该请求不进入任何缓存。

该页面刻意位于客户端插件树之外，因此其文案是固定的英文而非区域字典条目，也不跟随主题变化。将来若要向其插值，需要 CSP nonce 或 hash 取代当前的内联放行。

五秒窗口接受一种启发式：操作者提交错误 URL、五秒之后再次落到该页面且仍无 cookie 时，会多经历一次重试。代价是一次请求，优于循环。
