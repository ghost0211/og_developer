# Windows 构建指南（og developer）

本文档面向在 Windows 10/11 上构建 ogdeveloper 桌面安装包（`.msi` / `.exe`）。

## 1. 环境清单（装完核对一遍）

| 工具 | 验证命令 | 备注 |
|---|---|---|
| Rust (stable-x86_64-pc-windows-msvc) | `rustc --version` | rustup 安装，**必须 MSVC 工具链**（不能用 GNU） |
| Node.js LTS (>=20) | `node --version` | |
| pnpm 10 | `pnpm --version` | `corepack enable` 后自动按 packageManager 对齐 |
| Visual Studio Build Tools | 安装器里勾选「使用 C++ 的桌面开发」 | 含 MSVC + Windows SDK |
| NASM | `nasm -v` | **openssl vendored 编译必需**（winget install nasm） |
| Strawberry Perl | `perl --version` | **openssl Configure 脚本必需** |
| WebView2 Runtime | Win11 自带；Win10 需装常青版 | 运行时需要，构建不需要 |

> NASM + Perl 是因为 `sqlite-sqlcipher` 特性会从源码构建 OpenSSL。缺了会在
> `openssl-sys` 编译阶段报错，报错信息里会直接点名。

## 2. 拉取源码

Linux 开发机（192.168.2.27）已开 SSH，直接在 Windows PowerShell：

```powershell
git clone ssh://chentao@192.168.2.27/home/chentao/projects/og_developer
cd og_developer
```

（也可以先 `git bundle` 打包再拷贝，但 SSH 克隆最省事，后续 `git pull` 也方便同步。）

## 3. 构建

```powershell
# 安装前端依赖（首次约 2-5 分钟）
pnpm install

# 前端产物检查（可选，验证前端能独立构建）
pnpm build

# 完整构建：前端 + Rust release + 安装包
# 首次 Rust 全量编译约 20-40 分钟，取决于机器
pnpm tauri build
```

## 4. 产物

```
src-tauri/target/release/bundle/msi/ogdeveloper_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/ogdeveloper_0.1.0_x64-setup.exe
```

双击安装即可；`installMode: currentUser`，不需要管理员权限。

## 5. 常见坑

1. **openssl-sys 报错**：缺 NASM 或 Perl，看错误信息补装。
2. **link.exe 找不到 / LNK 错误**：VS Build Tools 没装 C++ 工作负载，或用了
   GNU 工具链（`rustup default stable-x86_64-pc-windows-msvc` 切回来）。
3. **pnpm 脚本策略报错**：PowerShell 执行策略限制，`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。
4. **杀毒软件拦截**：Tauri bundler 下载 Wix/NSIS 组件时可能被拦，加白名单或暂时关闭实时防护。
5. **JDBC 驱动首次下载**：应用内首次用 JDBC 模式连接时会从 Maven 中央仓库下载
   `opengauss-jdbc`，需要能访问外网；离线环境可提前在 驱动管理 里手动导入 jar。

## 6. 想加快迭代？

日常改动后重新出包只需重跑 `pnpm tauri build`（Rust 增量编译，几分钟）。
调 UI 时用 `pnpm tauri dev` 热更新（窗口直接开在 Windows 上）。
