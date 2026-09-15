# task-board-api(演示仓库)

零依赖 Node.js 任务看板 API,用于验证「代码转面试」管线。

- `server.js` 手写极简路由 + 统一错误处理 + 限流前置
- `store.js` 内存表 + 二级索引(等价微型数据库)
- `cache.js` LRU + TTL 缓存(Map 插入序实现)
- `ratelimit.js` 令牌桶限流(按 IP)
- `validate.js` 输入校验
- `tests/store.test.js` 断言式测试

运行:`npm start`(需 Node ≥ 18);测试:`npm test`
