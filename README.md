# 声场档案

本地音乐素材管理工具 —— 为剪辑师设计,用来管理、检索、标记音乐素材和片段。

数据用 **SQLite** 存在你本机的应用数据目录(而不是浏览器缓存),**音频文件仍保存在你原来的位置**,应用只记录路径和元数据。清浏览器缓存、清 WebView 缓存都不会影响音乐库。

![技术栈: Tauri v2 + Rust + SQLite + 原生 JS]

## 功能

- **导入音乐**:从磁盘选择或拖入音频文件,自动读取时长,只记录元数据 + 文件路径(不复制文件)
- **多视图检索**:全部音乐 / 音乐片段 / 最近添加 / 专辑 / Tag
- **搜索**:按名称、专辑、Tag 全局搜索
- **标签系统**:给音乐和片段打 Tag,侧边栏常用 Tag 快速筛选
- **片段标记**:在时间轴上拖动起止点,给音乐某一段做标记、命名、打 Tag
- **底部播放器**:点音乐行即内联试听,支持上一首/下一首在列表内连续播放;可在 Finder 中定位原文件
- **候选暂存**:试听时点「＋」把中意的歌加入候选清单,回头统一对比
- **文件重绑**:音乐文件被移动/改名后,可重新选择并绑定新路径

## 界面预览

### 音乐库、筛选与详情

![音乐库、标签筛选与音乐详情](docs/screenshots/全部音乐.png)

### 底部播放器、音乐片段与候选清单

![底部播放器、音乐片段与候选清单](docs/screenshots/播放器+候选清单.png)

### 在时间轴中标记音乐片段

![音乐片段编辑器](docs/screenshots/音乐片段.png)

## 给使用者的说明(不需要装任何环境)

> 如果你是剪辑师朋友、完全不碰代码 —— 这部分就够了。

你收到的是一个 `.dmg` 安装包，**不需要安装 Node、Rust 或任何开发环境**。新打包流程使用免费的 ad-hoc（临时）签名，未进行 Apple Developer ID 签名或公证；从浏览器下载后，macOS 仍可能要求首次手动允许打开。已经发布的旧包不会自动得到这个签名修复。

### 安装与打开

> 从 v0.2.6 开始，DMG 包含图形化安装与更新入口；v0.2.5 及之前的 DMG 仍是拖拽安装包。旧用户安装新版后继续使用原来的数据库，无需重建或重新导入。请勿将新安装脚本与旧 DMG 混用。

1. 按 Mac 芯片选择 DMG：M 系列下载 `aarch64`；Intel 下载 `x64`。
2. 打开新格式 DMG，双击「安装与更新声场档案」，点击「安装 / 更新」。无需输入命令或安装开发环境。
3. 首次安装放到系统“应用程序”；已安装过的在原位置更新（正在运行的那份优先），安装窗口会显示安装位置。只有当前账户不能写入该位置时才请求管理员密码。安装失败保留旧版，授权取消后停止安装。发现其他副本时只提示，不删除。
4. 等待安装窗口显示结果。新电脑没有音乐库配置时，在声场档案窗口中选择「打开已有音乐库」或「创建新音乐库」。移动硬盘没有连接时，按提示连接后重试。

若 macOS 首次阻止安装器打开，请按 **「系统设置 → 隐私与安全性」** 中的单应用允许流程操作，详见 [Apple 说明](https://support.apple.com/zh-cn/102445)。免费的 ad-hoc 签名不等于 Apple Developer ID 签名或公证，不能保证所有系统和设备策略都会允许打开。

### 在 App 内升级

应用启动后每天最多在后台静默检查一次更新；有新版本时右上角出现「有新版本」提示，设置按钮带一个小圆点，不会弹窗打断，也不会自动下载。打开提示或 **「设置」→「检查更新」**，点击「更新到 x.y.z」即可下载，下载完成后确认一次「现在重启 / 稍后」。更新面板显示当前安装路径、架构和其他标准副本，并可在 Finder 定位。程序验证已签名的兼容信息及安装包，先暂存。更新过程中安装器只显示进度窗口，完成后自动打开新版并关闭窗口；新版首次打开时提示「已更新到 x.y.z」，可查看本版更新内容。失败时按钮会换成下一步可做的事（重试检查、重新下载、导出诊断信息等），不会让同一操作反复失败。确认后忽略未保存的输入，不自动保存音乐、片段或标签草稿；等待已提交的操作完成后退出、替换并重新打开。已验证下载跨重启复用；下载及准备阶段可取消。确认安装成功后清理旧版，不长期保留可启动的备份。日常升级无需再次下载 DMG 或运行脚本。

v0.2.5 及更早的已发布版本没有此入口，需要先手动安装首个支持更新的版本。发布方需先配置更新签名 Secret，详见 [安装与更新说明](docs/macos-installer.md)。

**已有音乐库直接沿用**：更新安装只替换应用，保留本机 `settings.json` 和原 `library.db` 路径。新版打开同一份数据库，继续使用原有音乐、标签、片段、专辑标签和候选清单，无需重建或重新导入；数据库在移动硬盘上时，请先连接原硬盘。缺少位置配置的旧默认库只需选择「打开已有音乐库」，指向原 `library.db` 所在文件夹，之后会记住位置。

需要升级数据库结构时，程序先在原库旁生成包含已提交 WAL 数据的 SQLite 备份，再在一个事务中完成迁移和关联校验。失败会撤销整次迁移，保留原数据与备份；重试不会覆盖已有备份，也不会把原库替换为空库。

### 更新失败时

应用内“软件更新”窗口提供“导出诊断信息”：选择位置保存 ZIP，即使安装器未能启动或已退出也能导出。导出不会再次启动安装，取消保存不会改变更新状态；导出结果单独显示并保留原报错。内容限于更新上下文、最近安装/交接日志、启动尝试日志及安装状态；最近五个会话各保留最多五次启动尝试，单文件最多 2 MB。不包含音乐库、设置文件或音频，日志可能含本机路径。

更新窗口优先显示版本和当前状态，安装路径、原始错误及诊断保存路径默认折叠。导出成功后自动在 Finder 中选中 ZIP，窗口保留“在 Finder 中显示诊断文件”按钮，便于再次定位。若 Finder 未能打开，会明确提示文件已保存并允许重试定位，不会把已成功导出误报为失败，也不会覆盖原更新错误。

已发布的 0.2.6/0.2.7 没有这个按钮，且失败后会关闭安装器。使用新版安装器升级时，交接失败会先自动保存诊断 ZIP、在 Finder 中显示，并在旧应用的报错中给出文件位置，再把失败返回旧客户端。若磁盘权限等原因导致诊断保存也失败，会保留原更新错误并说明导出失败。

保留 DMG，重新打开其中的安装窗口即可：

- **重新尝试启动**：确认本次启动的实际结果，区分界面就绪、等待选择音乐库、音乐库不可用及启动失败。
- **恢复旧版（仅未完成更新）**：先退出应用并检查数据库兼容性，再恢复旧应用。音乐库不会被恢复操作复制或覆盖。无法确认兼容性、硬盘未连接、旧版早于 v0.2.5 且缺少安全元数据时，会保留备份并停止恢复。
- **导出诊断信息**：保存 ZIP 发给开发者，无需自己找日志。每次启动的日志独立保留，重试不会覆盖首次失败信息。不包含数据库、位置配置文件或音频，但日志和崩溃报告可能包含本机路径，请仅发给信任的人。

新版先复制、校验，再确认退出旧应用并等待已提交的操作完成，提交前临时保留备份。替换失败时会尝试恢复原应用；启动失败不会擅自降级。中断后可重新打开安装窗口处理未完成的更新。确认成功后不再提供旧版恢复；后续故障使用同版修复安装或更高版本。安装窗口不提供历史清理或位置选择入口；更新面板仅在清理未完成时提供重试。详见 [生命周期设计与验收](docs/installer-lifecycle.md)。

`scripts/install-macos.sh` 仅保留旧命令的兼容入口，`--replace` 会打开同一个安装窗口，不再直接移除旧应用。旧 DMG 缺少图形化入口时会停止，要求下载新版。

### 数据存在哪里

- 本机位置配置：`~/Library/Application Support/com.musicmanager.app/settings.json` 中的 `db_path` 记录数据库路径。没有这份配置时，不推断是否首次使用，而是让用户明确选择「打开已有音乐库」或「创建新音乐库」；创建还需选择保存目录并确认，不会自动生成默认空库。
- 底部「切换音乐库」用于打开所选文件夹中的 `library.db`，不会搬迁、复制、合并或覆盖当前音乐库；目录内没有数据库时，会先确认是否创建空音乐库。切换成功后刷新界面并记住位置，原数据库保留。
- 换电脑时，连接移动硬盘，在启动选择框中点击「打开已有音乐库」，选择旧 `library.db` 所在文件夹即可读取原有音乐、标签和片段；已进入应用时也可点击「切换音乐库」。复制数据库到其他设备前，应先关闭使用该库的应用，确保 SQLite WAL 中的数据已写回。
- 已设置的音乐库不可用时，启动会停止加载并提示连接移动硬盘，可在接好硬盘后点击「重试」或选择「退出」；不会补建目录、生成替代空库或回退到默认库。位置设置损坏时同样停止加载，不会静默使用空库。
- **音频文件不复制、不移动**,还在你原来的文件夹里
- 新导入的音乐会保存 macOS 文件书签。即使随后在 Finder 中移动或重命名文件，下次打开应用或播放前会自动更新库内路径；文件被删除或跨磁盘复制后再删除时才可能需要重新绑定。
- 若导入时选择「以文件夹名称为准」，每次启动同步路径时也会同步最新父文件夹名称为专辑名。升级前已有音乐会默认迁移为此来源，可在详情中改成 MP3 属性或手动填写；手动填写的音乐不受文件夹改名影响。

### 注意

- 应用内删除音乐/片段 = 从音乐库移除记录,**不会删除磁盘上的音频文件**
- 清空浏览器缓存对应用数据**没有任何影响**

## 给开发者的说明

### 项目结构

```
music-manager/
├── frontend/                # 前端(原生 JS + HTML + CSS,零框架零构建)
│   ├── index.html           # 主界面(含底部播放器、候选面板)
│   ├── app.js               # 全部逻辑
│   └── style.css            # 样式
└── src-tauri/               # Tauri v2 桌面壳
    ├── src/
    │   ├── main.rs          # 入口
    │   ├── lib.rs           # Builder 组装、数据库 setup
    │   ├── db.rs            # SQLite 连接 / 建表 / WAL
    │   └── commands.rs      # 全部 #[tauri::command]
    ├── tauri.conf.json
    ├── Cargo.toml
    └── capabilities/
```

### 技术要点

- **后端**:Tauri v2 + Rust,`rusqlite`(bundled SQLite)存本地数据库
- **前端**:原生 JS,通过 `window.__TAURI__` 全局 API 调 `invoke`,不引入 npm 包
- **音频**:库只存绝对路径,播放/剪辑时用 `convertFileSrc` + asset 协议把本地文件喂给 `<audio>`(已验证 WKWebView 下 seek 正常)
- **位置配置**:`app.path().app_data_dir()/settings.json`；数据库在用户明确选择的文件夹内。旧默认库可在 `~/Library/Application Support/com.musicmanager.app/library.db` 找到，缺配置时也需明确选择打开。
- **替换了原版 IndexedDB + File System Access API**:原版数据存浏览器、清缓存即丢,这是迁移为桌面应用的根本原因

### 环境要求

| 工具 | 版本 | 用途 |
|---|---|---|
| Rust | stable | 编译 Rust 侧 |
| [tauri-cli](https://github.com/tauri-apps/tauri) | 2.x | 开发/打包(`cargo install tauri-cli --locked`) |
| Xcode Command Line Tools | macOS | 编译 |

### 开发

```bash
# 安装 Rust(如果还没有)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# 安装 tauri-cli
cargo install tauri-cli --locked

# 启动开发模式(首次编译较慢)
cd src-tauri && cargo tauri dev
```

改 `frontend/` 下的文件后,刷新应用即可看到(无热重载,手动刷新窗口)。

### 在本机测试完整更新

在 `src-tauri` 目录运行：

```bash
cargo tauri dev --no-watch -- -- --local-update-test
```

这是 macOS 开发构建专用入口。两个 `--` 分别分隔 Tauri/运行器参数和应用参数；`--no-watch` 避免准备测试包时重复启动。入口会在普通应用和正式音乐库初始化之前转入测试流程，自动创建独立测试 App、带临时签名的更新 DMG、测试音乐库和仅监听 `127.0.0.1` 的更新服务，再打开测试 App。按平时的“检查更新 → 下载更新 → 重启并更新”操作即可走完整流程，不需要发布 GitHub Release、使用正式签名私钥或改正式版本号。首次需要构建两个 App 和一个 DMG，终端会输出进度及日志位置。

默认测试当前工作区版本升级到临时的下一个补丁版本。测试库位于 `/private/tmp/music-manager-desktop-local-*`，带一首生成的 WAV 和一个片段；请使用这份测试库。旧版在隔离 `Applications` 中原地更新，不会替换正式安装。若要测试原版旧客户端：

```bash
cargo tauri dev --no-watch -- -- --local-update-test --from-version 0.2.6
# 也支持 --from-version 0.2.7
```

历史客户端测试需要本地存在相应 `v0.2.6` / `v0.2.7` Git 标签。构建依赖未缓存时 Cargo 会正常下载依赖；需要离线运行时可在命令前加 `CARGO_NET_OFFLINE=true`。

保持启动终端运行，在测试 App 中操作更新。终端可输入以下命令后按回车：

| 命令 | 作用 |
|---|---|
| `success` | 重置旧版，测试正常升级 |
| `install-failure` | 重置旧版并制造安装记录错误，测试更新失败和诊断导出 |
| `bad-signature` | 重置旧版并破坏测试包，测试签名校验失败 |
| `repair` | 修复模拟故障，然后在 App 中重新下载或重试更新 |
| `open` | 从规范临时路径重新打开当前测试 App |
| `status` | 显示安装结果和日志位置 |
| `quit` | 退出测试并清理测试 App/更新包，保留测试库、日志和导出的诊断 |

场景切换复用已构建的包，不重新编译，保留测试音乐库，会退出当前测试 App。安装器正在工作时拒绝重置或清理，需先完成操作或关闭安装窗口。也可通过 `--scenario install-failure` 或 `--scenario bad-signature` 直接进入失败场景。结束后再次运行启动命令会使用新的隔离目录，纳入最新源码；该流程不提供热重载。普通 `cargo tauri dev` 仍按原方式运行。

测试脚本回归：`python3 scripts/test-local-update.py`，CI 会运行；覆盖环境隔离、版本规划、场景重置/修复、测试库保留及未知应用和符号链接保护。

数据库启动与切换的回归检查：`node --test scripts/test-database-switch.cjs`；后端测试：`cd src-tauri && cargo test --locked --lib`。覆盖硬盘未连接、数据库缺失、设置损坏、连接后重试、已有库和 WAL 数据保留、空目录确认创建、无效库拒绝、设置保存失败及切换时的在途操作。

每个 PR 和推送到 `main` 的提交都会运行 `.github/workflows/ci.yml`：Ubuntu 上做前端语法、Node 回归、更新清单和发布脚本测试，macOS 上做 Rust 与安装器回归。PR 的版本未发布，或包含任何代码、前端资源、依赖、安装器、构建脚本、CI 或未知路径变更时，自动在 Apple Silicon 和 Intel 原生构建机上各运行 release 测试、构建 App/DMG 并校验。只有版本已发布且完整差异仅涉及 `README.md`、`AGENTS.md`、`docs/` 的 PR 可以跳过打包；空差异默认构建，差异读取失败则失败，不猜测为纯文档。重命名按删除和新增检查，避免把代码移入文档目录后漏掉验证。

两套安装包构建后，`Release rehearsal (temporary key)` 使用临时密钥执行与正式发布相同的签名、验签及清单生成，并验证重复执行后候选文件字节不变。临时密钥仅保存在 runner 临时目录并清理，PR 不使用正式发布密钥、不创建 Release。固定检查 **`CI Ready`** 无论上游成功、失败或跳过都会执行：所有必需测试及计划要求的打包、预演必须明确成功，只有明确允许的跳过才能通过。手动运行仍测试、构建和预演，不发布，也不代替 PR 的必需检查。

仓库管理员需在 Settings → Branches 编辑已有 `main` 规则：开启 **Require status checks to pass before merging**，添加 GitHub Actions 的 **CI Ready**，开启 **Require branches to be up to date before merging**，保持 **Do not allow bypassing the above settings**。检查名称在首次运行后可搜索。此仓库设置由用户配置，修改 YAML 不会自动设置合并保护；用户手动合并 PR。

合并到 `main` 后，测试与 `CI Ready` 通过且版本号比已发布版本新时，重新构建正式安装包、签名、核对草稿远端资产后发布。没有新版本时只测试。正式发布前保存本次运行、同一提交的完整签名候选；失败重试恢复原候选，重新验签并核对清单，保持签名和时间戳原字节，避免已上传的草稿资产因重新生成而摘要不符。未找到保存候选时重新准备，但不会覆盖不匹配的草稿或已发布资产。手动运行与 main 发布使用不同并发组，避免相互占用同一等待位置。

Tauri CLI 按系统、架构和 CLI 版本独立缓存；安装并验证后立即保存，后续 DMG 失败也不丢失已准备的工具。构建依赖缓存允许失败后保存，构建、预演与发布复用同架构依赖。`node --test scripts/test-ci-workflow.cjs` 覆盖实际工作流条件、完整 Git 差异、CLI 缓存命中/缺失/旧版本和合并结果检查；`python3 scripts/test-publish-release.py` 覆盖部分上传恢复、已发布资产保护和签名候选复用。

波形失败与重试回归：`node --test scripts/test-waveform.cjs`。覆盖音频离线、HTTP 读取失败及解码失败时无未处理的 Promise 拒绝，失败后可重试，成功结果复用缓存。

安装更新专用回归：`node --test scripts/test-updater.cjs scripts/test-review-regressions.cjs scripts/test-database-switch.cjs`、`python3 scripts/test-update-manifest.py`、`python3 scripts/test-release-plan.py`、`python3 scripts/test-publish-release.py`、`python3 scripts/test-update-artifacts.py`，以及 `bash scripts/test-macos-installer.sh`。覆盖下载恢复、更新确认/忽略草稿/等待已提交写入、签名兼容信息、草稿发布和临时产物归属。完整命令与实测限制见 [生命周期设计与验收](docs/installer-lifecycle.md)。 Linux CI 执行隔离产物测试前会创建 `/private/tmp`，保持与 macOS 相同的验收目录约束；本机 macOS 无需额外准备。

完整前端回归：`node --test scripts/test-*.cjs`。`scripts/test-review-regressions.cjs` 覆盖详情异步加载与连续保存、关闭编辑确认、播放取消与队列、拖入导入、失败重试、批量删除、播放历史缓存、导入专辑来源及预览生成。`src-tauri/src/commands_regression_tests.rs` 覆盖 WAV 原文件保护与完整输出、标签事务回滚、大库标签统计、专辑移动及离线资料编辑；发布流程会运行这些检查。

交叉操作回归还覆盖自动保存与快速/批量标签同时写入、重新绑定文件时继续编辑、慢专辑探测后的手动修改与草稿保留、导入期间的编辑锁定及失败恢复，以及保存、探测或整批导入尚未结束时准备更新。更新会等待已经接受的完整操作；其中任何写入失败都会中止更新并恢复界面。导入批次执行期间暂时锁定曲目资料和专辑来源，完成或失败后恢复编辑。

面板与播放回归从实际按钮事件进入，覆盖列表、详情和片段面板的乱序读取、读取中发生保存或删除、关闭后迟到响应、Finder 同步时切换选择与保留草稿，以及删除当前或无关曲目时保留仍有效的试听和队列位置。详情与片段面板在同一次校验中提交记录和界面；片段编辑器及资料弹窗也会拒绝旧加载、旧保存和旧音频回调影响较新的编辑。

首页现在使用「奶油留白 / 月夜打盹」双主题插画，沙发进入音乐库、地毯进入最近播放、毛线球进入音乐片段。两个主题均有猫咪呼吸、尾尖轻摆及点击轻蹭互动，可关闭并遵循系统减少动态效果偏好。布局和入口说明见 [猫咪首页原型](docs/design/home-scene-layout.md)。回归检查：`node --test scripts/test-home-audition.cjs scripts/test-home-scene.cjs scripts/test-home-scene-motion.cjs`，包含切歌、取消、暂停续播、文件缺失、无唱机播放路径、双主题入口归属及动画生命周期；旧唱机模块保留但不再由应用入口加载。这些检查不替代真实窗口的视觉与交互验收。

### 打包

应用图标使用与奶油色首页一致的「蜷睡白猫与灰玫瑰色音符」，采用轻柔的奶油白和浅暖色阴影，无装饰边框、深色猫咪描边或唱片元素。插画原图为 `src-tauri/app-icon-artwork.png`，生成提示词见 [图标设计记录](docs/design/app-icon.prompt.txt)。修改插画后，在项目根目录运行 `node scripts/generate-app-icons.cjs`，通过无描边的圆角裁切生成 `src-tauri/app-icon.png`，并同步生成开发模式 Dock 和各平台打包图标。

发版不需要手动打标签：在合并到 `main` 的 PR 中同步更新 `src-tauri/Cargo.toml`、`Cargo.lock` 与 `src-tauri/tauri.conf.json` 的版本号，并写好 `docs/update-notes.txt` 与 `docs/release-notes.md`，合并后 CI 测试通过即自动构建两个架构、签名；先上传草稿并核对远端资产大小与摘要，再公开发布。标签与 Release 由 CI 创建，对应通过测试的那个提交。

本地从项目根目录构建（以 Apple Silicon 为例）：

```bash
rustup target add aarch64-apple-darwin
(cd src-tauri && cargo tauri build --bundles app --target aarch64-apple-darwin)
bash scripts/build-macos-installer.sh \
  "$PWD/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/声场档案.app" \
  "$PWD/music-manager_VERSION_aarch64.dmg"
```

Intel 使用 `x86_64-apple-darwin`，DMG 文件名后缀使用 `x64`。打包脚本要求输出路径尚不存在，拒绝架构不明确、缺少启动协议或数据库版本元数据不匹配的应用。

DMG 创建遇到 macOS 的 `Resource busy` 时最多尝试 3 次，间隔 2 秒、4 秒；其他错误立即失败。每次使用独立临时文件，通过镜像校验后才生成最终包，且不覆盖已有文件。回归：`node --test scripts/test-dmg-packaging.cjs`，覆盖临时占用恢复、重试上限、非重试错误、校验失败和已有输出保护。

应用和安装器均进行完整 ad-hoc 签名，发布前校验签名与 DMG 完整性。编译 Swift 只发生在开发者/CI 环境，使用者无需安装 Swift、Python、Node 或 Rust。免费签名不能代替 Apple 公证。

安装器主窗口沿用原来的四个按钮：安装 / 更新、重新尝试启动、恢复旧版、导出诊断信息；重试与恢复按事务状态启用。正常界面不显示安装路径，不提供位置选择、查看位置或历史清理入口。

安装器回归测试：`bash scripts/test-macos-installer.sh`。本机窗口布局检查：`python3 scripts/test-installer-ui.py`（需要可用的 macOS 图形会话；仅创建窗口，不读取安装或执行安装）。更多实现细节及测试边界见 [安装器说明](docs/macos-installer.md)。

### 常用命令(增删改查)

前端通过 `window.__TAURI__.core.invoke` 调用,完整清单见 `src-tauri/src/commands.rs`:

| 命令 | 作用 |
|---|---|
| `init_db` | 确认数据库就绪 |
| `probe_file` | 读取文件路径的元数据(名称/大小/mime) |
| `create_music` / `update_music` / `delete_music` / `get_music` / `list_music` | 音乐表 CRUD |
| `create_clip` / `update_clip` / `delete_clip` / `get_clip` / `list_clips` | 片段表 CRUD |
| `file_exists` | 判断音频文件是否还在 |

### 数据模型

数据库为 SQLite(文件 `library.db`,WAL 模式、外键开启)，当前 schema 版本为 `3`。所有 `*_at` 时间字段均为毫秒时间戳(INTEGER)。

旧版 Tag 数据库首次升级时会先通过 SQLite 生成 `library.pre-tag-tree-v1.db` 完整备份；其他结构升级或失败后的再次升级使用唯一命名的 `library.pre-schema-3-*.db`，保留已有备份。全部结构与数据迁移在同一个事务中完成，关联校验通过后才提交。恢复旧应用必须先确认它能读取当前数据库，不自动回滚数据库，也不要直接用旧备份覆盖已经继续编辑过的库。程序检测到高于自身支持范围的 schema 版本时会停止写入。

**music**(主键 `id`,音乐元数据;只存路径,不存音频文件本身)

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | `music_<时间戳>_<随机>` |
| name | TEXT NOT NULL | 音乐名 |
| file_name | TEXT NOT NULL DEFAULT '' | 完整文件名 |
| path | TEXT NOT NULL(唯一索引) | 音频文件**绝对路径** |
| album | TEXT DEFAULT '' | 专辑 |
| artist | TEXT DEFAULT '' | 艺术家 |
| genre | TEXT DEFAULT '' | 流派 |
| year | TEXT DEFAULT '' | 年份 |
| channels | TEXT DEFAULT '' | 声道(单声道/立体声) |
| sample_rate | INTEGER DEFAULT 0 | 采样率(Hz) |
| bitrate | INTEGER DEFAULT 0 | 码率(kbps) |
| duration | REAL DEFAULT 0 | 时长(秒) |
| file_size | INTEGER DEFAULT 0 | 文件大小(字节) |
| mime_type | TEXT DEFAULT '' | 音频 MIME |
| created_at / updated_at | INTEGER NOT NULL | ms 时间戳 |

索引:`name`、`album`、`artist`、`genre`、`year`、`created_at`、`path`(唯一)。

**clips**(主键 `id`,音乐片段;外键关联 music,级联删除)

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | `clip_<时间戳>_<随机>` |
| music_id | TEXT NOT NULL FK→music(id) ON DELETE CASCADE | 所属音乐 |
| name | TEXT NOT NULL DEFAULT '未命名片段' | 片段名 |
| start | REAL NOT NULL CHECK(start >= 0) | 起点(秒) |
| end | REAL NOT NULL CHECK(end > start) | 终点(秒) |
| created_at / updated_at | INTEGER NOT NULL | ms 时间戳 |

索引:`music_id`、`created_at`。

**tags / tag_categories**(树形标签与筛选维度)

`tags`:

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | 标签 id |
| name | TEXT NOT NULL COLLATE NOCASE | 标签名；同一父节点内不区分大小写且唯一 |
| category_id | INTEGER NOT NULL FK→tag_categories(id) ON DELETE RESTRICT | 所属筛选维度 |
| parent_id | INTEGER NULL FK→tags(id) ON DELETE RESTRICT | 父 Tag；NULL 表示维度根节点 |
| created_at | INTEGER NOT NULL | ms 时间戳 |

`tag_categories`:

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | 筛选维度 id |
| name | TEXT NOT NULL UNIQUE COLLATE NOCASE | 筛选维度名 |
| created_at | INTEGER NOT NULL | ms 时间戳 |

**music_tags / clip_tags**(音乐/片段与标签的多对多关联)

| 表 | 字段 | 说明 |
|---|---|---|
| music_tags | (music_id FK→music CASCADE, tag_id FK→tags CASCADE, PK(music_id, tag_id)) | 音乐-标签关联 |
| clip_tags | (clip_id FK→clips CASCADE, tag_id FK→tags CASCADE, PK(clip_id, tag_id)) | 片段-标签关联 |

索引:两表均在 `tag_id` 上有索引。

**candidate_entries**(候选暂存,多态引用 music 或 clips)

| 字段 | 类型 | 说明 |
|---|---|---|
| target_id | TEXT PK | 目标 music/clips 的 id |
| kind | TEXT NOT NULL CHECK(kind IN ('music','clip')) | 目标类型 |
| created_at | INTEGER NOT NULL | ms 时间戳 |

> 通过触发器 `trg_music_candidate_cleanup` / `trg_clips_candidate_cleanup`,删除 music/clips 时自动清理对应候选记录。

## License

私有项目,仅供内部分发使用。

安装与更新都在原位置进行，不搬迁、不删除其他位置的副本。安装记录保存在当前用户的 `~/Library/Application Support/com.musicmanager.installer/user`，不再使用系统级记录，也不支持多个账户同时更新同一份应用。0.2.6/0.2.7 的旧记录（`~/Library/Logs/com.musicmanager.installer/latest.json`）属于同一位置时直接沿用；属于其他位置且已完成时按原文归档到同目录的 `transactions`；其他位置有未完成事务时停止并提示先在那里完成或恢复。

安装窗口只在执行安装、重试或恢复时持有安装锁，空闲窗口不会阻塞应用内更新。手动安装成功并确认新版启动后，安装窗口会自动关闭。0.2.9 及更早的安装窗口打开期间一直持有锁；更新程序遇到时会请它们退出（等同于点关闭按钮，正在安装的窗口会拒绝），仍无法继续时提示用户关闭那个窗口。进程号只写入诊断文件。`bash scripts/test-macos-installer.sh` 覆盖原地更新、旧记录沿用与归档、锁的释放与重读，以及冲突时不留下日志、不请求授权。
