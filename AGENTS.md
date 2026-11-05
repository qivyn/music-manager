# AGENTS.md

声场档案：本地音乐素材管理的 macOS 桌面应用。Tauri v2 + Rust（rusqlite）后端，原生 JS 前端（零框架、零 npm、零构建），通过 `window.__TAURI__.core.invoke` 调用 `src-tauri/src/commands.rs` 中的命令。

## 先判断请求类型

- **只是询问项目细节**（某功能怎么实现、某数据存在哪、某命令做什么、测试覆盖了什么）：直接读代码和文档后回答，引用具体文件和行号。不改文件、不跑构建或整套测试、不建分支、不提交、不建 PR。确实需要运行某个命令才能确认答案时，只跑只读、快速的命令，并说明结果来自实际运行。
- **开发或修改功能**（新功能、修 bug、重构、改 UI、改打包或发布流程）：按下面的流程开发、验证、review，并在授权后提交。验证范围由实际改动决定，不把流程理解为每一轮都重跑全部测试。
- **只改文档、规则、版本号或发布说明**：按下方验证矩阵处理，不当作功能重写，不启动无关的构建和原生验收。

拿不准属于哪一类时，按询问处理，回答后问用户是否要改。

## 项目结构速览

| 位置 | 内容 |
|---|---|
| `frontend/app.js` | 前端主要逻辑（列表、详情、片段、导入、播放、更新入口） |
| `frontend/index.html`、`style.css`、`themes.css` | 主界面与样式 |
| `frontend/home-scene*.js`、`waveform.js`、`vinylwall.js`、`updater.js` 等 | 首页插画、波形、唱片墙、应用内更新等独立模块 |
| `frontend/.preview/` | 浏览器预览：`mock-tauri.js` 模拟后端，`build-preview.cjs` 由 `index.html` 生成 `preview.html`，`shot.mjs` / `shot.sh` 截图 |
| `src-tauri/src/commands.rs` | 全部 `#[tauri::command]` |
| `src-tauri/src/db.rs` | SQLite 连接、建表、WAL、schema 升级 |
| `src-tauri/src/lib.rs`、`startup_report.rs`、`updater.rs` | 启动与音乐库选择、启动状态报告、应用内更新 |
| `src-tauri/src/*_tests.rs` | 后端回归测试（`commands_regression_tests.rs`、`db_upgrade_tests.rs`） |
| `src-tauri/tests/fixtures/` | 各历史版本数据库 SQL，供升级测试使用 |
| `scripts/test-*.cjs` | 前端 Node 测试（`node:test` + `vm` 加载 `frontend/` 源码） |
| `scripts/release-plan.py`、`test-release-plan.py` | 发版判断：三处版本号一致、比已发布版本新、标签指向本次提交 |
| `docs/update-notes.txt`、`docs/release-notes.md` | 应用内更新说明与 GitHub Release 正文（`{{version}}` 会被替换） |
| `scripts/macos-installer/` | Swift 图形安装器及其测试 |
| `scripts/desktop-acceptance/` | 隔离验收用的独立 App / DMG 构建脚本 |
| `.github/workflows/ci.yml` | PR 按完整差异验证双架构 App/DMG 与发布预演，`CI Ready` 汇总；main 新版本自动发布；手动不发布 |

## 开发流程

### 1. 按改动风险验证，复用有效证据

测试用于排除具体风险，不以次数或通过数衡量完成度。**本地做有针对性的验证，PR CI 做完整回归；已经验证且未受后续改动影响的功能，不反复验证。**

1. **确定影响范围**：先读本次差异、相关代码和已有测试，明确影响哪些行为，以及哪些已有结果仍可复用。修 bug 时先补能够复现问题的回归测试，确认修复前失败。
2. **实现与补测**：新增或修改业务逻辑时补实际可运行的测试。纯文案、样式或排版调整不机械新增与实现一一对应的测试，使用相关界面检查即可。
3. **选择最小充分验证**：按下表运行受影响的测试和必要构建，不默认追加完整回归，不要求每项改动都同时做 Unit、Integration 和 E2E。
4. **处理失败**：修复后重跑失败项及受修复影响的检查。只有失败暴露了更广的风险，才扩大验证范围。不跳过测试或放宽断言来制造通过；确属测试过时才调整，并说明原因。
5. **Review**：检查最终差异、逻辑边界、错误处理、数据安全和测试覆盖。Review、用户询问“可以提交了吗”、准备 commit 或创建 PR，本身都不是重跑测试的理由。
6. **结束验证**：相关检查通过、需要的交互验收完成且没有已知阻塞问题后，就进入提交/PR 流程。不要继续寻找理由重复测试，不把“所有环境都测过”当作完成条件。

**什么时候复用，什么时候重跑**

- 已验证的代码、依赖、配置和运行路径没有受到新差异影响，结果继续有效。以相关内容和行为是否变化判断，不因 commit SHA、分支名、对话轮次或文件时间变化就认定证据失效。
- 只有相关逻辑/依赖/配置发生变化、出现新失败、发现未覆盖的具体风险，或用户明确要求复测时，才重跑对应检查。开始追加检查前，简短说明触发原因和要确认的问题；“更保险”“提交前再来一遍”不是充分理由。
- 修复安装器逻辑后验证过真实升级，之后只改发布说明或版本展示，不再重新跑下载、安装、重启、Finder 等整套流程。只改更新窗口排版，不重测旧版本数据库升级。
- 已完成本地完整回归的改动，后续只发生不影响功能的修改，可以直接复用结果。完整回归通常交给 PR CI；仅变更影响广泛、跨模块重构、依赖大幅变化、失败暴露系统性风险、影响范围无法明确界定或用户要求时，才在本地补一次。
- 用简短记录保存验证范围、命令、结果和限制；可复用已有聊天或项目验证记录，不为每次询问重复生成长报告、截图或测试环境。汇报时区分“本轮新执行”和“复用已有结果”。

### 2. 验证矩阵与常用入口

| 本次实际改动 | 本地验证要求 |
|---|---|
| `README.md`、`AGENTS.md`、普通文档或发布说明 | Review 内容、必要的链接/格式检查。**不跑功能测试、构建或 GUI 验收。** |
| 仅同步版本号与发布说明 | 核对三处版本一致、版本格式、发布说明及版本是否可发布。复用功能测试和 E2E 结果；**不重跑全量回归、历史版本升级或整套 GUI。** 发布产物的构建/签名/元数据校验由 CI 完成；确需本地候选包时只构建该候选一次。 |
| 前端文案、样式、排版 | 检查受影响页面/状态，必要时查看截图。只有修改 JS 时才做相应语法或逻辑测试；不因此重跑 Rust、数据库、安装器测试或 Rust 构建。 |
| 前端业务逻辑 | 修改文件的语法检查、相关 `scripts/test-*.cjs`；涉及实际交互变化时补对应场景的预览或原生验收。 |
| Rust 业务逻辑、查询或内部重构 | 相关模块的单元/集成测试，必要时检查调用方。`cargo test` 已编译覆盖的代码不再机械重复 `cargo build`；入口二进制或测试未覆盖的构建路径改变时再构建。 |
| IPC、系统对话框、文件权限或平台集成 | 相关自动化测试，加一次受影响的真实调用/原生交互检查；不重复验证未变的界面和后端路径。 |
| 启动、库切换、数据库迁移、更新或安装器逻辑 | 相关回归，按风险选择代表性的隔离真实场景。schema、迁移或数据库兼容性逻辑变化时跑受影响的历史库升级矩阵；更新交接、安装替换等升级行为变化时跑相应场景，不无条件重复所有历史版本与故障组合。 |
| 依赖、打包、签名、权限、`Info.plist`、图标或构建配置 | 检查实际受影响的构建与运行路径；确需 App/DMG 验证时构建一次。**文件名命中不等于需要全测**，例如只改 `tauri.conf.json` 的版本字段仍按“仅版本号”处理。 |

若版本变更同时涉及 schema、协议、最低兼容版本或特殊版本迁移分支，就不是“仅版本号”，应按对应行为验证。无法在本机覆盖的 Intel、跨账户、实体硬盘等环境如实说明，交由对应 CI/人工验收；不要用重复本机测试代替缺失的环境。

按上述矩阵需要新增自动化覆盖时，沿用以下层级：

**Unit**
- Rust：在对应模块的 `#[cfg(test)] mod tests` 里加测试。
- 前端：在 `scripts/test-*.cjs` 中新增或扩展测试。沿用现有写法：`fs.readFileSync` 读取 `frontend/` 源码，`vm` 运行所需片段，注入假的 DOM / `invoke`。新文件命名为 `scripts/test-<功能>.cjs`，会被 CI 的 `node --test scripts/test-*.cjs` 自动收入。

**Integration**
- 命令与数据库：`src-tauri/src/commands_regression_tests.rs`，用临时目录里的真实 SQLite 和真实音频文件（`tempfile`、`hound`）。
- schema 或迁移逻辑变化：在 `db_upgrade_tests.rs` 覆盖受影响的历史版本 fixture；发布新 schema 时覆盖所有支持的历史版本，并在 `src-tauri/tests/fixtures/` 补该版本的 SQL。
- 更新清单：`scripts/test-update-manifest.py`；安装器：`scripts/macos-installer/tests/main.swift`。

**需要 E2E 时的执行方式**
- 只验证本次受影响的交互。浏览器预览足以验证布局时使用预览；只有原生对话框、真实 IPC、安装交接等行为需要时才用真实 App，不为了同一布局同时重复两套验收。
- UI 预览可生成预览页后用无头 Chrome 截图，并读取截图确认结果：
  ```bash
  node frontend/.preview/build-preview.cjs frontend/index.html frontend/preview.html
  (cd frontend && python3 -m http.server 8931) &
  node frontend/.preview/shot.mjs "#<hash>" /tmp/mm-shot.png 2500 1440 900 "<可选的页面内 JS>"
  ```
  `shot.mjs` 会输出页面异常和 console error，有输出就要处理。新增后端命令时同步更新 `mock-tauri.js`，否则预览会失效。
- 真实平台行为使用隔离配置下的 `cargo tauri dev` 或隔离打包 App，选择适合该行为的一种即可。完整自更新需要可替换的测试 App，可使用 `cargo tauri dev --no-watch -- -- --local-update-test`；不要求普通 dev 和打包 App 各做一遍相同操作。
- 需要验证启动、音乐库切换、更新、安装器等高风险行为时，参照 `docs/startup-validation-v0.2.5.md` 和 `scripts/desktop-acceptance/`，使用独立 identifier 和 `/private/tmp` 下的隔离目录；场景完成后停止，不反复新建同类环境。

**完整回归参考命令（默认由 CI 执行，不是每轮本地待办）**
```bash
node --check frontend/app.js
node --check frontend/updater.js
node --test scripts/test-*.cjs
python3 scripts/test-update-manifest.py
python3 scripts/test-release-plan.py
(cd src-tauri && cargo test --locked --lib)
```
安装器相关回归入口为 `bash scripts/test-macos-installer.sh`。本地按影响范围选择所需套件，CI 按工作流执行完整检查。

**需要构建时的入口**
- Rust 二进制：`(cd src-tauri && cargo build --locked)`。
- App：`(cd src-tauri && cargo tauri build --bundles app --target aarch64-apple-darwin)`。
- DMG：`scripts/build-macos-installer.sh`，参数见 README「打包」。
- 以上命令按验证矩阵选择，不是每次修改都要依次执行的清单。已有构建已覆盖相同代码和配置时复用，不重复构建。

### 3. 提交与 PR

- **用户明确授权提交后**才 commit；没有授权时只汇报改动和验证结果，然后询问。授权在同一任务范围内持续有效，不对已经授权的相同提交/PR 操作反复确认。
- 当前在 `main` 时，先建分支（如 `feat/<简述>`、`fix/<简述>`），不直接提交到 `main`。只暂存本次改动相关的文件，不要顺带提交工作区里其他无关修改。
- 推送分支后创建 PR（`gh pr create`；本机未装 `gh` 时先 `brew install gh && gh auth login`）。PR 描述包含：
  - **改动**：做了什么、为什么、影响哪些模块，数据库 schema / 用户数据是否受影响。
  - **实际验证结果**：执行的命令和真实输出摘要（通过数 / 失败数）、必要的 E2E/构建结果，以及复用了哪些仍有效的证据；无需为写 PR 再执行一遍。
  - **未验证 / 风险**：没覆盖到的场景和原因。
- PR 的完整回归、双架构构建和发布预演由现有 `ci.yml` 按其条件执行，固定检查 `CI Ready` 必须通过。CI 失败先定位、修复，并在本地复跑相关失败项；不把一次 CI 失败扩展成所有本地检查重来。
- **CI 结果必须对应 PR 当前提交与有效基线**：新提交或 main 更新后由 CI 重新验证，不能把旧提交的绿灯当作新提交的结果。**这不意味着已经验证且未受影响的本地功能也要重跑。**
- CI 不替代确实需要的本地交互验收，但本地验收完成后可以随未改变的行为复用。不要为单个 PR 临时修改 CI 规则；本文件的验证原则调整也不隐式修改 `ci.yml`。main 的必需检查和严格更新设置由用户在 GitHub 配置。
- **不自动合并**：不执行 `gh pr merge`、不开启 auto-merge，由用户手动合并。
- **发版由合并触发，不手动打标签**：合并到 `main` 后 `ci.yml` 自动运行，测试通过且版本号比已发布版本新时，构建两个架构、签名并创建 tag 与 Release；版本号没变则只测试、不发布。`workflow_dispatch` 只测试并构建 DMG，不发布。
- 只有用户要求发版时才改版本号；发版同时要写 `docs/update-notes.txt` 和 `docs/release-notes.md`，CI 会检查两份说明都包含 `v<版本号>`。

## 必须遵守的约束

- **不碰用户真实数据**：开发和测试不读写 `~/Library/Application Support/com.musicmanager.app/` 下的正式配置与 `library.db`，也不修改用户的原始音频文件。测试用临时目录；真实窗口验收用独立 identifier（参照 `scripts/desktop-acceptance/build-fixture.py`）。
- **数据安全**：删除音乐或片段只删记录，不删音频文件。数据库升级必须先备份、在单个事务中迁移并校验，失败整体回滚；音乐库不可用时等待重试，不创建替代空库。
- **前端不引入 npm 包或构建步骤**，保持原生 JS；第三方代码放在 `frontend/vendor/`。
- **版本号**：发版时同步修改 `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`，CI 会校验三者一致，并据此判断是否发布。普通功能修改不要改版本号。
- 改了用户可见的行为、命令或测试入口时，同步更新 `README.md`。
