# B 站专栏 Playwright 适配（实验阶段）

目标是复用博客内容，保存草稿或按原文章 ID 更新，并在审核通过、公开正文读回一致后确认发布。全程使用 Playwright 的网页会话、原生编辑器操作和网站读取接口；不使用 B 站开放平台应用或本地浏览器扩展。

已用真实账号验证 0x00 的草稿创建、同 ID 重写、保存后独立重开对比，以及独立无窗口浏览器中的读取验证。另在同一草稿中验证了原生图片上传、图片地址复用及图注保存，随后恢复了原文。尚未完成真实公开发布、已发布文章更新或 GitHub 托管 Runner 的账号验证。新版发布表单仍需适配，保持 `allowPublish: false`；不要把草稿验证通过当作公开发布已经打通。

## 配置与调用

复制 `examples/bilibili-sync.json`，将 `authorMid` 的示例值 `12345` 替换为实际目标账号 UID，填写来源目录。首次仅配置试验文章并保持 `newArticles.enabled: false`，该字段只控制是否自动发现未绑定的文章；显式配置的无 ID 文章可保存新草稿。

```yaml
- uses: Arcueid77/article-sync-action@FULL_REVIEWED_COMMIT_SHA
  with:
    platform: bilibili
    mode: draft
    article: spherewright-0x00
    source-root: source
    config: blog/bilibili-sync.json
    expected-sha: ${{ steps.source.outputs.sha }}
    bilibili-storage-state: ${{ secrets.BILIBILI_STORAGE_STATE }}
    github-token: ${{ github.token }}
```

使用独立配置、独立状态分支、独立 Secret 和工作流串行锁。继续保留成功部署版本选择、过期部署跳过和默认分支可信事件检查。不要把 B 站会话放入知乎 Secret，也不要修改知乎已有 ID 或状态分支。

一次性手动登录：

在聊天或远程环境中显示二维码时，使用独立进程持续等待扫码并自动保存，避免临时交互工具结束后丢失浏览器会话：

```sh
npm run auth:bilibili -- --directory /private/new-capture-directory
# 已知 UID 时可增加 --author YOUR_MID，防止登录错误账号。
```

进程将二维码图片路径写入该目录的 `status.json`，扫码确认后立即保存 `storage-state.json` 和只含公开身份的 `identity.json`，然后退出。目录必须位于所有 Git 工作区之外；每次捕获使用新目录，不覆盖旧会话。首次捕获通过用户扫码选择账号；发布时仍按配置中的 `authorMid` 核对账号。登录过程默认十分钟，到期后停止。刷新二维码可在同一目录写入 `refresh-request.json`；状态文件会返回新的图片路径。此命令不上传 GitHub Secret。

本机可交互窗口也可继续使用原登录命令：

```sh
npm run auth -- --platform bilibili --author YOUR_MID
# 只有显式指定后才会写入目标仓库的 Secret：
npm run auth -- --platform bilibili --author YOUR_MID --github-repo OWNER/CONTENT_REPO
```

会话仅包含 `bilibili.com` 及其子域，默认存放在用户数据目录 `ArticleSyncAction/bilibili/private/storage-state.json`，不进入仓库。普通 Chrome profile 不会被读取。程序不自动输入密码、处理验证码或切换账号。

本地调用：

```sh
node src/bilibili-cli.mjs --mode plan --source-root /content --config blog/bilibili-sync.json --output /private/preview
node src/bilibili-cli.mjs --mode draft --article spherewright-0x00 --source-root /content --config blog/bilibili-sync.json --state-file /private/bilibili-state.json --registry /private/bilibili-registry.json
```

`plan` 离线转换（允许域内的远程配图仍可能下载）；`verify` 读回对比；`draft` 保存并重新打开同一草稿核验，绝不点击提交文章；`apply` 保存后执行一次原生提交，并记录待审核。`apply` 还要求配置 `allowPublish: true`，默认关闭；真实编辑器和发布表单核验前不要启用。

## 格式、图片与链接

- 默认标题含系列前缀，不自动截断；超过 40 字时报错，可为映射明确指定 `title`。副标题作为正文首段独立引用。
- 标题层级、代码缩进、链接、强调、列表、图注必须通过正文对比。B 站新版编辑器没有行内代码样式，改用原生灰色背景文字区分，文字仍可复制；代码块保留原来的代码格式和缩进。平台粘贴或保存后丢失内容或这些格式会停止。
- 表格按行展开，保留表头、值、链接及行内格式。不会把整个表格截图作为正文替代。
- 图片使用原生文件上传控件，取得网站确认并检查 CDN 地址可加载后持久保存。新版编辑器使用自身的图片复制格式粘贴，避免把已上传图片再次导入成不同地址。图注使用原生图片注释，限纯文本及平台的 100 字符上限；富文本或超长图注报错，不静默截断。
- SVG/BMP 转为 PNG，静态 WebP 可转 PNG；当前工具保守限制为静态 PNG/JPEG、最多 5 MiB，动画或超限图片明确报错。这是工具限制，并非平台所有上传入口的统一上限。
- 每张图片都必须上传成功且可加载；上传失败不删除图片继续发布。状态只记录源文件哈希及无签名参数的稳定 CDN 地址。报告移除 B 站图片地址中的查询参数。
- 文章映射保存实际验证过的 `publicUrl`，接受 B 站 `read/cv...` 与 `opus/...` 地址。不会拿草稿 ID 猜图文 URL。已有站内链接和上下篇使用已确认发布的 B 站地址；未发布的目标保留博客原链接，不生成错误 B 站地址。
- 本批次新文章通过审核后，应再次触发以补全关联链接；不会在待审核期间重复提交来刷新导航。
- `draft: true` 或 `bilibili: false` 跳过 B 站；`zhihu: false` 只影响知乎。

## 状态与恢复

`allocating → draft → submitting → review_pending → published`

分配前先保存意图，取得 ID 后立即保存；后续均复用该 ID。创建前查询并核对完整本人文章列表，同名未绑定文章要求先绑定，不会创建第二份。响应结构不明确时停止。

新版编辑器在创建中心的独立 iframe 内运行。读取既有草稿时，先核对网站返回的草稿 ID 和富文本数据，再等待编辑器加载对应正文；保存后从新页面重新读取。网站返回的纯文本摘要不作为格式校验证据，编辑器的行号、链接图标及空图片注释也不计入正文。

提交前先保存 `submitting`。结果未知、审核中或公开页仍是旧版本时，后续触发只读回核对，不再次创建或提交。只有公开作者、地址、正文及格式与已提交版本一致，才转为 `published`。报告中的 `pending` 不表示发布成功。后续内容变更等前次提交核实后再处理。

审核可能跨越一次 Actions 运行。需要在内容仓库配置定时 `verify` / `apply` 来读回；当前不会自动创建定时任务。`verify` 不持久更改状态；`apply` 才会记录审核完成并处理新版本。平台拒绝、登录失效、验证码或限流会停止；不尝试代理、指纹或账号轮换。
