# ACNH Tracker

一个零运行时依赖的《集合啦！动物森友会》生物收集追踪器。页面支持鱼、昆虫和海洋生物筛选，收集状态保存在浏览器本地，并可导出或导入 JSON 备份。

## 本地运行

直接双击 `index.html` 即可在 Edge、Chrome 或 Safari 中使用。

> 直接打开和 `http://127.0.0.1` 属于不同的浏览器来源，本地收集记录不会自动互通。请选择一种方式长期使用；如果此前通过 HTTP 使用，请先在旧页面导出记录，再在直接打开的页面中导入。

开发时也可以通过本地 HTTP 服务打开：

```bash
python3 -m http.server 8082
```

然后访问 <http://127.0.0.1:8082/>。

## 验证

要求 Node.js 22 或更高版本，无需安装依赖：

```bash
npm test
npm run check
```

`npm test` 覆盖备份兼容性、旧筛选迁移、安全存储、批量撤销、筛选纯逻辑以及 200 条生物数据的不变量。`npm run check` 额外检查所有 JavaScript 文件的语法。GitHub Actions 会对提交和拉取请求运行同一检查。

## Cloudflare Workers 部署

运行 `npm run deploy` 即可部署。Wrangler 精确固定在项目开发依赖中；安装完成后会自动执行 `npm run check`，因此 Cloudflare Builds 在 bundle 过期或测试失败时不会继续部署。`wrangler.jsonc` 将仓库根目录设为静态资源目录，`.assetsignore` 只允许上传 `index.html`、`bundle.js` 和 `favicon.png`，避免把依赖、源码和测试文件作为公开资源上传。

## 代码结构

- `index.html`：页面结构、视觉样式和响应式规则。
- `app.js`：浏览器启动、DOM 渲染与交互绑定。
- `schema.js`：类别定义与南北半球月份派生，不依赖应用层逻辑。
- `core.js`：可独立测试的筛选、迁移、备份、存储和收集状态逻辑。
- `ui.js`：提示消息、确认对话框与安全 HTML 转义。
- `data.js`：北半球生物数据；南半球月份统一由北半球月份平移六个月生成。
- `bundle.js`：由源码模块生成，供直接双击 `index.html` 时加载，请勿手工编辑。
- `scripts/build-bundle.mjs`：运行 `npm run build` 重新生成 `bundle.js`。
- `scripts/module-parser.mjs`：解析并限制兼容包支持的模块语法。
- `tests/core.test.js`：零依赖 Node.js 测试。
- `tests/file-open.test.js`：防止直接双击打开页面的兼容性再次回归。

## 数据与备份约束

- 生物 ID 是跨版本保存和导入的稳定标识，不应随显示名称变更。
- 备份对象当前版本为 `1`；旧版纯数组备份仍可导入，未知版本会被拒绝。
- 有效备份最多包含当前已知生物数量的记录，文件上限为 64 KB。
- 修改北半球月份后无需手工同步南半球字段，运行测试即可验证派生结果。
