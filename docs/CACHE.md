# 缓存（`src/core/cache/`）设计与 key 清单

> 维护约定：新增/改动缓存 key 时同步更新本文档清单。
> **代码里不集中登记 key** —— key 由**使用它的模块自己定义**（`@core/cache` 只提供通用能力，
> core 不得反向依赖业务模块）。

## 设计

- 能力：进程内 KV + TTL + 按 tag 批量失效（`CacheStore` 单例 `cache`）。
- **写穿透失效是主路径**：`Database.insert/update/delete` 成功后按**表名**调用
  `cache.invalidate(表名)`，因此应用内改数据后不会读到旧缓存。
- TTL（默认 60s）**只是兜底**，防止某个 key 漏挂失效点时长期脏读；`ttl: 0` 表示永不过期。
- `tag` 恒等于**数据来源表名** → 一次失效覆盖该表全部派生缓存。
- 进程级单例（不参与模块 `close`）；**不跨进程**（将来多实例需换 Redis / 总线广播）。

## key 清单（唯一人工维护点）

| key                          | 归属模块               | 内容                                                                                    | tag（= 来源表）      | TTL      |
| ---------------------------- | ---------------------- | --------------------------------------------------------------------------------------- | -------------------- | -------- |
| `autoControl:configDefaults` | `modules/autoControl`  | `direct_config` 的 code → default_value（阈值全局默认值，逐帧再合并设备级 `direct` 值） | `direct_config`      | 默认 60s |
| `sensorModule:config`        | `modules/sensorModule` | 派生计算配置（窗口秒数 / 跳变阈值，读 `direct_config.default_value`）                   | `direct_config`      | 默认 60s |
| `sensorModule:mapper`        | `modules/sensorModule` | `sensor_data_mapper` 的 `api_name` → `db_name`                                          | `sensor_data_mapper` | 默认 60s |

## 编码规范

1. **key 由使用它的模块定义**（模块内常量 + 注释写明用途与 tag）。不得在 `@core/cache`
   集中登记业务 key —— 那会让 core 反向依赖业务模块，新增模块就得改 core。
2. 命名：`<模块>:<用途>`，模块名用调用方模块名（`sensorModule` / `autoControl`）。
3. 读取统一用 `cache.remember(key, loader, { tag })`；`tag` 必须等于来源表名，写错/自造会导致
   「应用内改数据后缓存永不失效」，只剩 TTL 兜底（最多脏 60s）。
4. **loader 不要返回 `undefined`**：命中判据是 `value !== undefined`，返回 `undefined` 等于
   **永不缓存（每次回源 DB）**。空结果请返回 `[]`、`null` 或带默认值的对象。
5. 只缓存「低频写、高频读」的**全局**数据（配置 / 映射表）；**设备级数据不进缓存** ——
   `direct` 表按 `d_no` 的行由自动控制每帧直读，这正是「前端改配置立即生效」的前提。
6. **绕过 `Database` 写库**（裸 SQL / 外部工具 / 其它进程）必须手动 `cache.invalidate(表名)`，
   否则最多脏 60s。同理：改全局配置的 E2E 需在**服务启动前**改，或改用设备级覆盖。
7. 不要手动 `cache.set` 回填（不做 write-through 回写）—— DB 是唯一权威，下次读自然回源。

## 测试

- 单测：`tests/core/cache.test.ts`（读写 / tag 批量失效 / TTL / `remember` 只加载一次）。
- 写穿透联动（Database 写库 → 缓存失效）在 `tmp/` 的 E2E 中验证，见 `docs/TESTING.md`。

## 暂缓

- 「全库查询中间件 / 表级缓存策略配置」（`docs/TODO.md` ③）：读接口按时间窗口查询、命中率低、
  结果集大，缓存收益不足；等出现明确读放大或多实例一致性需求再做。
