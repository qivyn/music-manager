# 安装与更新生命周期（未发版）

基线：main `cb2a063`。应用版本仍为 0.2.7，数据库 schema 仍为 3。本次不操作正式配置、音乐库、音频或开发者历史安装。

## 用户行为

最终产品规则：统一安装到系统“应用程序”，安装器不显示路径、不提供位置选择和历史清理入口。底部保留原版四个按钮。旧位置的正式副本根据当前客户端、运行进程、用户应用程序目录及迁移记录识别，验证后迁移，启动确认后清理；未知、开发目录和 DMG 副本不删除。

下载校验独立签名和已签名兼容元数据，记录版本、架构、包摘要、协议、最低系统和客户端。验证后的下载可跨进程复用。安装先暂存和校验，再通过「确认 / 取消」协调退出。确认后忽略未保存的输入，不自动保存或校验音乐、片段及标签草稿；已经提交的写入仍须完成。手动安装与应用内更新进入同一 Swift 事务。旧客户端不支持退出协议时要求自行保存并退出。

启动以令牌、版本、PID 和实际应用路径确认。ready、待选库、缺盘保护均为有效安装结果，须维持至少两秒；主动退出选库单独记录。失败或超时不提交。提交后旧版删除，不再提供恢复旧版；之后以同版修复安装或更高版本处理。音乐库不随应用恢复或清理。

## 状态、权限与文件

- Rust 下载协调状态位于应用缓存的 `updates`，每次使用前重新验签和核对摘要。
- 用户安装事务位于 `~/Library/Application Support/com.musicmanager.installer/user`；系统事务在 `/Library/Application Support/com.musicmanager.installer/system`，与 Logs 分离。
- 目标锁覆盖不同日志目录；系统锁由 root 创建、所有账户可读取并加锁。正常启动遵守目标锁，安装器明确启动的子进程可回报启动状态。
- 管理员操作通过一次授权的短期 Swift 执行器处理，只允许固定安装路径与限定文件动作；不接受任意 shell，不以 root 启动应用、不打开音乐库。
- 暂存与恢复应用在目标卷内；新命令、记录读写、删除均拒绝受管路径中的符号链接。macOS `/var`、`/tmp` 系统别名例外。
- 用户主动选择退出前，后端门禁拒绝新写入并等待已接受操作完成；取消或失败解除门禁。

阶段：检查 → 下载 → 已验证 → 已暂存 → 等待退出 → 替换 → 已就位 → 启动确认 → 已提交 → 清理完成。清理失败保持已提交，不降级。移动边界与状态落盘中断由原事务对账处理。

提交后清理旧版、失败新版暂存、下载包与内嵌应用；正在执行的安装器稍后清理。未引用且未交接的有效下载超过24小时可清理。有明确运行归属标记的日志默认30天/100 MiB；未标记的历史或未知目录不自动删除。已完成事务摘要保留20条；活动和待清理事务不按期限丢弃。未知文件不自动清理。

历史事务保持原始记录，验证身份和路径后使用。历史残留内部方法保留，但普通界面入口已移除。不能确认的文件保留。事务损坏停止替换、恢复并允许导出诊断，不靠删除记录解除保护。

## 接口与兼容

保留 `check_app_update`、`download_app_update`、`restart_for_app_update`。增加安装状态、持久化更新状态、取消、退出准备/撤销、重试清理和 Finder 定位。进度带事务ID；界面重新打开时查询后端。更新错误包含稳定类别与可读信息。

安装器接受协议1旧参数和协议2新参数，旧包名称与内嵌路径保持。新客户端下载前要求签名兼容元数据；独立元数据绑定DMG摘要，旧清单字段保持以兼容旧客户端。

主应用提供 `--installer-update-info` 只读检查入口，不创建窗口或打开数据库。打包验证构建内的版本、公钥指纹、更新端点和协议，防止发布不能继续更新的版本。

当前公钥不轮换。`updater-trusted-public-key.txt` 表示本次发布的签名信任根，通常与应用公钥相同。轮换时先保持旧信任根与旧签名Secret，应用内置新公钥；兼容元数据携带 `nextPublicKey`，由旧钥签名授权并绑定新指纹。过渡版发布后，下一次发布同步切换信任根和Secret到新钥。轮换须单独验收，禁止同时失去旧钥；私钥丢失时通过手动安装恢复更新链，不放宽签名校验。免费签名不等于 Developer ID 或公证，首次系统放行限制仍存在。

## 发布与测试入口

沿用单一CI与main新版本自动发布。构建产物增加 `.dmg.metadata.json`，发布任务签名DMG与元数据，验证后生成清单。先创建带提交来源标记的草稿、上传资产、核对远端大小/摘要，再公开；仅允许重试同提交草稿，不覆盖已发布版本。

```bash
node --check frontend/app.js
node --check frontend/updater.js
node --test scripts/test-*.cjs
python3 scripts/test-update-manifest.py
python3 scripts/test-release-plan.py
python3 scripts/test-publish-release.py
python3 scripts/test-update-artifacts.py
bash scripts/test-macos-installer.sh
(cd src-tauri && cargo test --locked --lib)
(cd src-tauri && cargo build --locked)
(cd src-tauri && cargo tauri build --bundles app --target aarch64-apple-darwin)
```

验收脚本支持从 `v0.2.6`、`v0.2.7` 构建隔离旧客户端。生成的验收App从共享bundle输出中移出，只允许清理有验收清单的独立目录；不删除整个target。

验收记录与未覆盖项目在交付时单列。模拟权限、跨进程锁和故障注入不能代表真实跨账户授权、Intel实机、不同macOS或断电验证。

旧版 0.2.6/0.2.7 固定校验 `AI-AQI/music-manager` URL，因此过渡清单继续使用该地址，由 GitHub 重定向到 `qivyn/music-manager`；新客户端仅允许这两个明确地址，包签名仍为最终信任依据。发布前必须核对旧地址仍映射到当前仓库；失效时停止发布并通过手动安装迁移，不扩大到任意地址。

## 本轮实际验证（2026-11-03）

实现分支 `codex/installer-lifecycle`，基线 `cb2a063`；未提交、未推送、未发布，正式版本号仍为 0.2.7。下列 0.2.10～0.2.15 仅为 `/private/tmp` 隔离验收的临时版本号，不是已发布版本。

| 实际执行 | 结果 |
|---|---|
| `node --check frontend/app.js`、`node --check frontend/updater.js` | 成功 |
| `node --test scripts/test-*.cjs` | 212 通过、0 失败 |
| `python3 scripts/test-update-manifest.py` | 3 通过 |
| `python3 scripts/test-release-plan.py` | 12 通过 |
| `python3 scripts/test-publish-release.py` | 3 通过 |
| `python3 scripts/test-update-artifacts.py` | 4 通过 |
| `bash scripts/test-macos-installer.sh` | 73 通过；包含真实临时文件移动与子进程，权限和签名失败由 FakeIO 注入 |
| `(cd src-tauri && cargo test --locked --offline --lib)` | 70 通过、0 失败 |
| `(cd src-tauri && cargo build --locked --offline)` | 成功 |
| `CARGO_NET_OFFLINE=true cargo tauri build --bundles app --target aarch64-apple-darwin` | 成功，完整 ad-hoc 签名 App |
| `bash scripts/build-macos-installer.sh <App> <临时候选.dmg>` | 已成功生成候选 DMG、验证嵌套签名与 hdiutil 校验和、生成绑定摘要的兼容元数据 |
| 预览生成、`shot.mjs` 更新面板截图、读取图片 | 完成，未输出页面异常或 console error |
| 隔离 `cargo tauri dev --no-watch --config <独立标识>` | 启动并回报 `ready`；当时 Mac 已锁屏，未把开发窗口视觉检查计为通过 |
| `git diff --check`、Python 语法与打包 shell 语法 | 通过 |

已检查基线 main 的 GitHub Actions：前端、后端/安装器和发布判断成功；构建、发布按条件跳过。当前新增实现尚未提交，因此没有当前分支 CI 通过的声明。

真实桌面验证使用独立 identifier、临时 SQLite、生成的 WAV 和临时更新签名：

- 已下载更新退出后重新打开，恢复“已下载待安装”，没有重复下载。
- 从 `v0.2.6` 标签构建的隔离原客户端完成协议1交接、替换并回报 ready；其提交标记生成成功，后续统一维护也清除了旧客户端缓存。
- 补验完成：从 `v0.2.7` 标签构建的隔离原客户端，通过真实窗口执行检查、下载、签名校验、确认重启，升级至当前代码的临时 0.2.15。新版窗口正常展示测试音乐，事务 `completed`、启动结果 `ready`、`cleanupPending=false`；测试库逐表快照一致（排除应用版本元数据与系统书签字段），音频 SHA-256 一致，旧版 App 与下载缓存均为零。证据：`/private/tmp/music-manager-desktop-lifecycle-20261103/evidence/original-0.2.7-final-update.json`。
- 隔离新客户端完成协议2交接，提交后旧版 App 为零、更新缓存目录为空。
- 手动安装请求运行中应用确认；取消后原应用继续运行，重试确认后更新完成，恢复旧版按钮禁用。
- 更高版本接续失败的启动确认事务，保留音乐库与音频，成功后清理本事务及已被修复事务取代的旧版。
- 所有已完成实际升级前后，测试音乐记录保留，WAV SHA-256 不变。
- 连续五次提交后不残留旧 App，由 Swift 集成测试覆盖；不等同于五次生产安装器的人工实测。

实际验收发现并修复了本项目对 `/tmp` 与 `/private/tmp` 的路径比较问题。Tauri 自身仍拒绝某些经 `/tmp` 别名启动的进程初始化 updater；未开启其危险 symlink 选项。后续检查更新测试从规范路径重新启动隔离客户端。验收脚本的事务目录替换也已增加断言，避免隔离环境误读其他状态目录。

另核对了 v0.2.6/v0.2.7 公钥与当前一致；旧命名空间的实际 v0.2.7 安装包 URL 跟随重定向返回 HTTP 200。

### 尚未完成与保留材料

- 真实系统目录管理员授权、跨账户并发、Intel 实机、不同 macOS、断电与实体移动盘插拔未实测；相应自动化模拟不能替代这些验证。
- 草稿上传、远端摘要验证、公开发布和密钥轮换未对正式 GitHub Release 执行；发布器和密钥授权路径由隔离测试覆盖。
- 本机可执行的原版 0.2.7 升级补验已完成；上述硬件、授权及发布环境项目仍单独保留为未实测，不能宣称全环境实测通过。

本轮隔离应用、安装器、源码副本与下载包已按归属清单清理，核对隔离根目录内 `.app` 数量为零；此前为锁屏保留的恢复压缩包也已删除。保留日志、证据 JSON、测试库及不可直接启动的生产配置构建证据。测试 HTTP 服务与隔离应用均已停止，没有清理开发者此前的历史应用或正式安装。

收尾发现验收清理脚本同时登记父目录与子文件时会重复删除并报错；已先增加失败测试，再改为按路径深度从子项开始清理，4 项产物测试通过，并实际完成清理。该修复仅影响隔离验收脚本。

### 安装器界面收敛（历史记录，已由默认安装规则取代）

主窗口恢复原版四个按钮，新增三个入口移至顶部「工具」菜单。`python3 scripts/test-installer-ui.py` 在修改前因七个按钮失败，修改后四项窗口检查通过；隔离原生窗口实际确认主窗口与菜单，截图 `/private/tmp/music-manager-installer-four-buttons.png`，未执行安装，预览 App 已清理。重新执行前端语法检查、Node 212 项、更新清单 3 项、发布判断 12 项、Rust 70 项、Swift 安装器 73 项，全部通过；`git diff --check` 通过。仅修改原生安装器布局及菜单，没有改应用替换、签名或更新协议，因此本次未重复应用升级或 Tauri 打包。


### 最终默认安装与旧位置迁移（2026-11-03）

此规则取代早期“唯一安装原位置更新”和“可选当前用户安装”。正常安装界面不显示路径，不出现位置选择、Finder 或历史清理入口；底部保留原版四个按钮。首次及后续安装均以系统 Applications 为目标。已验证的旧来源保留到新版启动确认后，再核对身份/签名/摘要及目录 inode/device 后删除；清理失败记录待清理，不能撤销已提交安装。受保护的任意旧路径不会交给 root 清理。

旧来源按当前交接客户端、运行中的正式应用、用户 Applications 及持久化迁移记录确认，不扫描全盘。已关闭且不在已知位置的旧 App 无法自动发现。旧版客户端若在自定义目录拒绝检查更新，使用新 DMG，由安装器识别运行中的旧版；不支持安全退出协议的旧版需先保存并退出。旧位置未完成的恢复事务仍先处理。

实际新增验证：

| 命令/操作 | 结果 |
|---|---|
| `node --check frontend/app.js`、`node --check frontend/updater.js` | 通过 |
| `node --test scripts/test-*.cjs` | 212 通过、0 失败 |
| `python3 scripts/test-update-manifest.py` | 3 通过 |
| `python3 scripts/test-release-plan.py` | 12 通过 |
| `python3 scripts/test-publish-release.py` | 3 通过 |
| `python3 scripts/test-update-artifacts.py` | 4 通过 |
| `python3 scripts/test-installer-ui.py` | 4 项真实 AppKit 窗口检查通过；不读取正式安装 |
| `bash scripts/test-macos-installer.sh` | 79 通过；新增迁移、清理重试、来源变化、错误身份、符号链接、降级及系统临时路径别名覆盖 |
| `cargo test --locked --offline --lib --manifest-path src-tauri/Cargo.toml` | 70 通过、0 失败 |
| `cargo build --locked --offline --manifest-path src-tauri/Cargo.toml` | 通过 |
| `CARGO_NET_OFFLINE=true cargo tauri build --bundles app --target aarch64-apple-darwin` | 通过 |
| `build-fixture.py <隔离根目录> 0.2.7 v0.2.7` 与 `0.2.16` | 原标签旧客户端和最终候选构建成功；0.2.16 仅为测试版本 |
| `package-fixture.py <隔离根目录> 0.2.16` | DMG、嵌套签名、DMG 校验和通过 |
| 原版 0.2.7 从 Legacy 迁入 Applications | 实际窗口确认 ready，事务 completed，cleanupPending=false，旧位置 App 已删除；逐表快照与 WAV SHA-256 一致 |

补验根目录 `/private/tmp/music-manager-desktop-migration-20261103`；证据 `migration-evidence.json`、`before.json`、`after.json`。截图 `/private/tmp/music-manager-installer-default-final.png`。真实系统管理员授权、跨账户与 Intel 等限制仍按上文单列；此处用隔离 Applications 模拟系统目标，不宣称已操作真实 `/Applications`。

详尽功能核对见 [安装更新变更清单](installer-change-inventory.md)。

最终生产配置 DMG 也已通过 `bash scripts/build-macos-installer.sh <arm64 App> <临时 DMG>` 构建、签名与校验；仅本地构建，未安装或发布。验收结束后退出两个进程并按归属清单清理，隔离根目录剩余 `.app` 数量为 0，截图、日志、数据比对证据和生产配置 DMG 保留。`git diff --check` 通过。

## 2026-11-04：简化更新确认

按最新产品要求，点击「重启并更新」只弹一次「确认 / 取消」。确认后不检查或自动保存音乐信息、详情、片段及标签草稿，直接进入更新准备；取消则保留当前输入和交互。已接受的操作仍须完成，后端写入门禁保留。删除原先的 `resolveUpdateDrafts` / `hasUnsavedDetailForUpdate` 及其六项旧需求测试，改在完整前端测试环境中加入六项确认、忽略草稿和取消回归；它们在修改前全部失败，修改后全部通过。这也移除了更新专用自动保存路径对未修改字段进行空白归一化的风险。

本次实际检查：

| 命令 / 验收 | 结果 |
|---|---|
| `node --check frontend/app.js`、`node --check frontend/updater.js` | 通过 |
| `node --test scripts/test-*.cjs` | 212 通过，0 失败 |
| `python3 scripts/test-update-manifest.py` | 3 通过，0 失败 |
| `python3 scripts/test-release-plan.py` | 12 通过，0 失败 |
| `(cd src-tauri && cargo test --locked --lib)` | 70 通过，0 失败 |
| `node frontend/.preview/build-preview.cjs frontend/index.html frontend/preview.html` | 通过 |
| `python3 -m http.server 8931 --bind 127.0.0.1` + `node frontend/.preview/shot.mjs` | 确认/取消、未保存详情输入、不产生草稿保存请求通过；截图已读取，页面异常及 console error 为 0 |
| 隔离副本 `cargo tauri dev --no-watch` | 构建并启动；裸二进制不能由截图工具绑定，随后使用独立 App 窗口验证 |
| 隔离副本 `cargo tauri build --debug --bundles app --ci` | 构建成功；真实原生确认/取消两条路径通过 |
| `git diff --check` | 通过 |

原生验收使用独立 identifier `com.musicmanager.acceptance.528b3c7ade5f` 及 `/private/tmp/music-manager-desktop-confirm-20261104` 测试库。已下载状态和最终替换交接由验收适配器模拟，原生弹窗及 `prepare_update_exit` / `abort_update_exit` IPC 为真实调用；没有执行应用替换，也不将此记录算作一次完整升级验收。测试曲目业务字段及测试音频摘要一致；正常启动补写的位置书签和 `updated_at` 单列排除，不宣称数据库字节完全相同。并发验收日志有 6 行交错，两个原生选择及准备/撤销完成记录完整；未据损坏日志断言全部命令序列。

真实弹窗截图：`/private/tmp/mm-update-confirm-native.png`；预览截图：`/private/tmp/mm-update-confirm-preview.png`；验收摘要：`/private/tmp/music-manager-desktop-confirm-20261104/confirmation-evidence.json`。已退出并按归属清单删除本次测试 App 和源副本，保留证据。此次仅修改前端退出交互及说明，未重跑系统替换、双架构与跨账户安装；未提交或发版。

## v0.2.8 发布准备

2026-11-04 用户授权提交、创建 PR 和发布新版本；原计划“不改版本、不发版”的阶段性限制在此解除。三处版本同步为 0.2.8，两份发布说明更新。发布仍通过用户合并 main 后的 CI 完成，不手动打标签或自动合并 PR。

远端基线仍为 `cb2a063df5965fb2d1b2f645b9ab38679af98473`；[合并后的 main CI](https://github.com/qivyn/music-manager/actions/runs/41606066137) 已核验为成功。GitHub 已发布最新版本是 v0.2.7；`scripts/release-plan.py --require-newer` 实际查询确认 v0.2.8 可发布。

可随 PR 查看窗口证据（均为隔离验收，不包含正式音乐库）：

![更新确认弹窗](assets/installer-lifecycle/restart-confirmation.png)

![安装器四按钮界面](assets/installer-lifecycle/installer-window.png)

安装器截图中的 0.2.16 是隔离验收使用的临时版本号，不是本次正式版本；本次发布目标为 0.2.8。

版本改为 0.2.8 后，重新执行前端语法检查、Node 212 项、更新清单 3 项、发布判断 12 项、草稿发布 3 项、产物治理 4 项、Rust 70 项、Swift 安装器 79 项及原生窗口 4 项检查，全部通过、0 失败。`cargo build --locked` 和 `cargo tauri build --bundles app --target aarch64-apple-darwin` 均成功。

实际执行 `bash scripts/build-macos-installer.sh <arm64 App> /private/tmp/music-manager-release-v028-20261104/music-manager_0.2.8_aarch64.dmg`，DMG、嵌套 ad-hoc 签名及 hdiutil 校验均通过，兼容元数据确认版本 0.2.8、架构 aarch64、schema 3，包摘要与实际 DMG 一致。此本地候选未安装、未公开上传；正式资产由合并后的 CI 重新构建和签名。

首次 PR CI 在 Ubuntu 的两项产物测试中发现 `/private/tmp` 不存在（测试尚未进入断言）。已在 Linux CI 测试步骤创建该目录；未跳过测试，也未扩大验收清理允许的目录范围。修改后本地 22 项 Python 检查及 workflow YAML 语法检查通过；Linux 实际结果以随后 PR CI 为准。
