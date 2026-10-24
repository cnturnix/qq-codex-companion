# Companion 实施审计 · 2026-10-23

关联：[规格](../GPT_Companion_Codex_Implementation_Spec.md) · [阶段状态](companion-implementation-status.md) · [方向](../方向文档.md) · [决策](../历史决策.md) · [蓝图](../执行蓝图.md)

## 已核实基线

- 真实入口 `src/napcat-main.mjs`，启动链为 `.cmd → Windows PowerShell → Node`。无 Git 仓库；以备份清单和校验和记录改动基线，不伪造 git diff。
- Node v24.19.0，项目依赖为 ONNX Runtime；Sharp 复用既有加载器。实测内置 `node:sqlite` 可用，SQLite 3.53.3、FTS5 可创建；新数据采用独立 SQLite WAL，不新增依赖。
- 开发前实际运行现有测试：88/88 通过。检查时 QQ、Codex、WD 均连接/就绪；这是 2026-10-23 的快照，不代表永久在线。
- 原配置、群记忆、图片索引、源文件、测试、Windows 启动脚本共 52 个文件已备份，带 SHA-256 清单。备份位置由 `work/companion-p1-backup.json` 记录，不在报告中输出真实用户资料。

## 源码接点与所有权

| 原位置 | 已有职责 | 新接点 |
|---|---|---|
| `src/napcat-main.mjs` | 单一 OneBot、Codex、MediaLibrary、Companion 实例及实例锁 | 初始化一个可降级的记忆服务，仍复用同一 Codex 客户端 |
| `Companion.accept/ingest/loadHistory` | 允许名单、潜水丢弃、50/30 条历史、增量上下文 | 不加抓取；已明确删除的来源可被排除，不扩大原查询范围 |
| `Companion.run` | 概率、模型、取消、实际发送 | 请求前只读相关记忆；全部实际发送成功且仍有效时异步捕获本轮事件 |
| `Companion.send` / `OneBotClient.sendImage` | OneBot 回执、图文分发 | 只使用原回执，不新建发送者；失败提示和未发送草稿不成为学习证据 |
| `src/codex.mjs` | 独立 thread、结构化输出、只读沙箱 | 学习用临时 thread，限制调用，聊天/识图优先，可中断学习 |
| `src/console-server.mjs` | 本机 Host/Origin 与 Bearer 鉴权 | 同一认证后增加记忆设置、提取、审核、暂停、删除接口 |
| `ui/console.html` | 原管理页面、人设编辑框 | 增加“记忆与成长”；人设框保留编辑，后台刷新不覆盖未保存文字 |
| `src/record-storage.mjs` | 配置化文本与媒体目录 | 新数据置于其文本目录下 `companion/companion.db`；不导入或覆盖旧摘要 |

## 完成边界和隔离

有效回合要求：原路由已允许、记忆留存开启、模型完成、计划发送均获回执、未取消/撤销允许名单/活跃到期。定时未抽中、silent、异常降级文字、部分发送均不提取成功互动。一个回合多条文字与图片合并为一次证据单元。

来源事件 ID 由本程序对渠道、会话、平台消息 ID 作稳定摘要；人物绑定来自 OneBot sender，群来源由路由决定，模型不能提交自己的 room/principal。群事实仅当前群；私人关系仅已验证的当前私聊；Persona 共享内容第一阶段只允许本机管理员明确创建。候选不直接注入聊天。

## 文档差异与采用决策

1. 规格部分旧基线仍泛称新图片识别；采用最新代码：只自动读 QQ 表情，普通图片/截图明确要求才读，聊天不等标签，每轮最多 5 张新图。
2. 主动冷却已为 2 秒；其余现行配置以磁盘值为准，不重置为文档示例。原 4 秒消息合并仍独立。
3. 规格的人格面板建议原人设只读；用户明确要求原“性格与说话方式”框继续可编辑，未来自动变化也显示其中，因此不采用只读替换。P3 需保留固定核心与动态风格来源，显示有效性格，手动保存优先并防止版本冲突。
4. 现有摘要写入发生在发送前，不能把它当实际互动完成事件；新学习钩子放到成功发送后的保守边界。
5. 本轮 P0/P1 不实现自动人格、习惯晋升或情绪；不创建其空模块，也不把既有图片服务列为待重建项。

## 运行与资料边界

第一阶段新功能默认关闭、候选试运行开启；管理员在原页面显式开启后才记录新完成回合，无旧消息补抓或批量导入。SQLite 或提取失败仅停用新服务，原聊天继续。管理员永久删除来源时要撤销相关派生记忆并使相关模型会话失效；旧人工群档案不由新服务改写。

实现依据提供的行为契约，没有复制四个 DSH 仓库代码。参考链接保留在原规格。SQLite 接口另核对 [Node 官方 v24 文档](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)，并在本机实际验证；未引入 DSH API 或新模型 Key。

2026-10-23 用户追加：学习后的性格语义可选择“各群独立”或“全群共享”，默认各群独立。P3 的性格编辑框显示所选群或共享版本，仍可手动改；作用域切换不自动公开群事实、私人记忆或原始证据。共享风格只接收管理员批准的非私人泛化风格。

## 2026-10-24 实施验收补记

P0/P1 已交付，新增代码位于 `src/companion-core/{policy,event-adapter,store,core}.mjs`，接入修改为 `companion.mjs`、`napcat-main.mjs`、`media-library.mjs`、`companion-settings.mjs`、`console-server.mjs` 与 `ui/console.html`。新增 `test/companion-core.test.mjs`，原测试行为保留；最终 109 项通过。当前命令行 Node 版本为 v24.22.1，早期审计的 v24.19.0 是当时基线。

性格范围已成为可保存的设置，自动性格尚未实现。管理页、真实 Codex 和当前运行服务已核验；备份、限制与后续任务见 [实施状态](companion-implementation-status.md)。本轮不重写规格里的历史基线或将未完成的 P2/P3 标为完成。

## 2026-10-24 P2–P5 验收补记

新增成长策略与存储模块接入原队列及数据库，版本升为 3，业务接点仍按前述所有权执行。原设置保存增加只校验阶段与学习视图版本检查，固定人设仍由原 Settings 保存；人格派生由成长事务保存，模型不能直接写固定核心。新增鉴权路由覆盖习惯操作、提案、回滚、反思、局部心情重置及零 QQ 发送的预览。

全部 126 项测试、浏览器和真实 Codex 虚构提取通过；正式升级后原记录及配置校验通过，数据库完整性 ok，QQ / Codex / WD 就绪。最新备份及启用方式见 [实施状态](companion-implementation-status.md) 与 [成长指南](companion-growth-guide.md)。
