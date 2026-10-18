# Article Sync Action

[![CI](https://github.com/Arcueid77/article-sync-action/actions/workflows/ci.yml/badge.svg)](https://github.com/Arcueid77/article-sync-action/actions/workflows/ci.yml)

把 Git 中的 Markdown 文章持续同步到内容平台。由 GitHub Actions 独立运行：新文章发布一次，后续复用原 ID 更新，并读回已发布正文核验。

Source-controlled article publishing and updates for GitHub Actions. The first adapter supports Zhihu. No local browser extension or runtime LLM is required.

**当前范围：知乎，Ubuntu 24.04 GitHub 托管 Runner。** 使用 Node.js 22 和 Playwright；不调用知乎 CLI。公众号、B 站等适配器尚未实现。

## 已有能力

- `plan` 离线预览、`verify` 核验、`apply` 发布或更新；默认 `plan`。
- 正文以仓库为准，知乎端手工修改会在下次 apply 时被覆盖；完全一致时不重复提交。
- 持久保存文章 ID、创建阶段和图片标识；分配 ID 或提交发布结果未知时，停止重复创建／发布，保留现场用于核对。
- 副标题、标题层级、代码、列表、普通表格、图注和图片链接适配。富文本表格可以按行展开，保留链接与行内代码。
- 本地图片、SVG/BMP 转换、允许域名内的远程图片；临时签名地址不进入状态记录或 HTML/JSON 报告。
- 博客文章内链与系列前后篇转换为已发布的知乎 URL；新文章批次结束后刷新关联链接。
- 独立文章的执行失败不会阻断其他文章；共享登录态、身份或状态存储故障会停止整个批次。输入预检失败会在任何写入前停止。

## 快速开始

1. 将 `examples/article-sync.json` 复制到你的内容仓库根目录，填写博客地址和知乎个人主页 URL 中的作者标识。
2. 默认将 Markdown 放在 `posts/`，站点根路径图片放在 `public/`；也可以配置自己的目录。
3. 配置下方 workflow，先运行 `plan` 查看 Artifact 中的预览。
4. 按登录说明将专用会话保存为内容仓库的 Secret `ZHIHU_STORAGE_STATE`，然后运行 `verify`，核对报告后运行 `apply`。

```yaml
name: Sync articles
on:
  workflow_dispatch:
    inputs:
      mode:
        type: choice
        options: [plan, verify, apply]
        default: plan
permissions:
  contents: write
concurrency:
  group: article-sync-zhihu
  cancel-in-progress: false
jobs:
  sync:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7.0.1
        with:
          persist-credentials: false
      - uses: Arcueid77/article-sync-action@main
        with:
          mode: ${{ inputs.mode }}
          expected-sha: ${{ github.sha }}
          zhihu-storage-state: ${{ secrets.ZHIHU_STORAGE_STATE }}
          github-token: ${{ github.token }}
```

这是早期版本；生产使用应把 `@main` 替换为已审核的完整提交 SHA。Action 自身不创建定时任务。自动跟随博客部署可使用 [部署完成触发示例](examples/deployment-sync.yml)：固定成功部署的来源提交，并在执行前跳过过时的部署事件。

### 配置与文章

见 [完整示例配置](examples/article-sync.json) 与 [示例文章](examples/posts/hello-world.md)。

| 配置 | 用途 |
| --- | --- |
| `blogUrl` | 博客 HTTPS origin，例如 `https://example.org` |
| `authorUrlToken` | 知乎主页 `/people/` 后面的标识；用于核对登录账号 |
| `source.articlesDir` | Markdown 目录，递归扫描；文件名是全局唯一的小写 slug |
| `source.publicDir` / `assetDirs` | 根路径资源目录／允许读取的图片目录，均相对 source-root |
| `source.articlePath` / `seriesPath` | 文章与系列 URL 前缀，默认 `/blog/`、`/series/` |
| `source.seriesTitle` | `plain` 保留原标题；`hex` 使用 `0x00：`；`decimal` 使用 `0：` |
| `assetHosts` | 允许下载的外部 HTTPS 图片域名；每次重定向都会重新校验 |
| `richTableMode` | `rows` 按行展开富文本表格；`notes` 保留表格并补充格式化注释 |
| `articles` | 已有文章的明确 ID 绑定；ID 必须是字符串 |
| `columns` / `newArticles.seriesColumns` | 系列和知乎专栏映射；有系列的文章必须明确映射 |
| `newArticles.enabled` | 是否允许新建未绑定的正式文章 |
| `newArticles.stateBranch` | 独立状态分支，例如 `dev/article-sync-state` |
| `newArticles.declaration` | 新文声明，明确选择 `无声明` 或 `包含 AI 辅助创作 作者对内容负责` |

Astro 示例：`articlesDir: blog/src/content/blog`、`publicDir: blog/public`、`assetDirs: [blog/public, blog/src/assets, blog/src/content/blog]`。

已有文章绑定示例：

```json
"articles": {
  "hello-world": { "id": "12345678901234567890", "enabled": true, "published": true }
}
```

Frontmatter 必须包含非空 `title`；`description` 可选，作为引用副标题。`draft: true` 或 `zhihu: false` 会跳过。`series` 和非负整数 `seriesOrder` 必须同时出现。仅支持 `.md`，不执行 MDX／Astro 组件。暂不支持的 HTML、公式、播放器或文章章节锚点会明确报错。

### 登录与本地命令

克隆本工具仓库后：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install chromium
# 专用浏览器中手动登录；作者标识必须匹配。
npm run auth -- --author YOUR_ZHIHU_PROFILE_TOKEN --github-repo OWNER/CONTENT_REPO
# 无知乎访问的预览，使用示例内容。
npm run plan -- --source-root examples --output /absolute/path/to/preview
# 本地在线操作需显式提供仓库外的登录态和持久状态文件。
npm run sync -- --mode verify --source-root /path/to/content-repo --state-file /private/state.json --registry /private/article-registry.json
```

登录命令只保存知乎域名的会话，默认写入系统用户数据目录 `ArticleSyncAction/zhihu/private/`。指定 `--github-repo` 会将会话上传到该仓库的 `ZHIHU_STORAGE_STATE` Secret。不会访问日常 Chrome profile，不自动输入密码或处理验证码。新仓库不会自动继承旧仓库的 Secret。

### Action 输入与输出

输入详见 [action.yml](action.yml)：`mode`、`article`（默认 `all`）、`source-root`、`config`、`expected-sha`、`zhihu-storage-state`、`github-token`、`upload-artifacts`。目录可含空格，输入通过环境变量和参数数组传递。

输出 `report` 是 JSON 报告路径，`output-directory` 包含预览及核验快照。默认上传保留 14 天的 Artifact；内容可能包含待发布文章，可将 `upload-artifacts` 设为 `false`。登录态不进入 Artifact，并在结束时删除临时会话文件。

状态写入内容仓库独立分支的 `article-sync-state.json`，使用文件 SHA 防止并发覆盖。新建顺序为 `allocating → draft → publishing → published`。务必保留工作流级串行 `concurrency`，不要把状态分支纳入博客部署触发范围。

## 验证边界

- `plan` 不访问知乎；配置中的外部图片可能触发下载。它不自动读取云端状态分支，本地可用 `--registry` 导入已导出的记录。
- `verify` 不主动填写正文、不点击更新／发布；打开编辑页可能触发知乎自身草稿自动保存，因此不是严格的 HTTP 只读模式。
- `apply` 只接受已提交的文章、图片和配置；在线 Action 仅接受本仓库默认分支的可信事件，拒绝 PR 事件。
- 登录失效、验证码、限流和网站拒绝会停止对应操作；没有代理、指纹或账号轮换。其他平台需要各自验证。
- 当前发布后执行有界读回核验。跨运行的延迟核验调度仍在路线图中，不能把未确认的提交算作成功。
- 首版代码源自作者博客的知乎同步工具；原工程曾完成真实文章的 Actions 核验。本仓库 CI 使用合成文章和本地模拟编辑器，不持有真实账号凭据，不代表每个账号都能在托管 Runner 发布。

## 开发

```sh
npm test
npm run test:browser
```

测试覆盖真实 Chromium 的富文本粘贴／上传交互、已发布正文与草稿区分、元数据保留、失败恢复、图片隐私、路径边界，以及非 Astro 目录。测试不访问真实知乎。

`src/source.mjs` 处理来源约定；`core.mjs`、`assets.mjs` 处理转换；`browser.mjs`、`web.mjs` 实现知乎适配；`registry.mjs`、`synchronize.mjs` 管理持久状态。当前转换器仍包含知乎规则，并非已经实现的平台无关适配框架。

后续：发布待核验状态与延迟读取、明确的平台能力接口、按平台验证公众号和 B 站适配器。欢迎贡献最小复现和脱敏格式样本。

MIT License.
