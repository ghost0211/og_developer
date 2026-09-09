# OG Developer

专门的 openGauss 数据库开发工具。基于 [dbx](https://github.com/t8y2/dbx)
（Apache-2.0）的深度定制版，专注 openGauss 一种数据库，做透方言细节与
PL/SQL 开发体验。

## 仓库布局

- 本目录（`projects/og_developer`）—— OG Developer 工作仓库
  - `main`：产品主线（品牌化、入口裁剪、专用特性都在这里）
  - `opengauss-fixes`：干净的 openGauss 修复集，可用于给上游提 PR
  - remote `dbx`：本地参考仓库（`projects/dbx`）
  - remote `upstream`：GitHub 上游，定期 `git fetch upstream && git merge upstream/main`
- `projects/dbx` —— dbx 原始代码参考仓库（只读参考，不在此开发）

## 与原版的差异

1. **品牌化**：展示名 `OG Developer`，productName `ogdeveloper`，identifier `com.ogdeveloper.app`，
   版本从 0.1.0 起步。
2. **入口裁剪**：连接类型选择器只保留 openGauss
   （`ConnectionDialog.vue` 里的 `ENABLED_DATABASE_TYPES` 白名单，
   上游完整代码原样保留，放宽白名单即可恢复）。
3. **openGauss 修复集**：见 [OPENGAUSS_FIXES.md](OPENGAUSS_FIXES.md)
   （切分器/对象树/源码/类型，已真机验证）。
4. Rust crate 名（ogdeveloper-core 等）与二进制名暂保持不变，降低追上游成本；
   安装包产物名由 Tauri `productName` 决定。

## 路线图

见 [OPENGAUSS_ROADMAP.md](OPENGAUSS_ROADMAP.md)
（官方 6.0 手册 + 7.0 真机实测得出的特性清单与实施顺序）。

## 开发

```bash
pnpm install          # 前端依赖
pnpm dev              # 前端开发服务器
pnpm build            # 前端构建
pnpm tauri dev        # 桌面端（需 webkit2gtk/fontconfig 等系统库）
npx vitest run        # 前端测试
cargo test -p ogdeveloper-core --no-default-features \
  --features duckdb-sidecar,mq-admin,sqlite-sqlcipher --lib   # Rust 测试
```

测试实例：本机 Docker 容器 `opengauss`（openGauss-lite 7.0.0-RC3，端口 5432）。
