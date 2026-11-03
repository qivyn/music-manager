# AGENTS.md

声场档案：本地音乐素材管理的 macOS 桌面应用。Tauri v2 + Rust（rusqlite）后端，原生 JS 前端（零框架、零 npm、零构建），通过 `window.__TAURI__.core.invoke` 调用 `src-tauri/src/commands.rs` 中的命令。

## 先判断请求类型

- **只是询问项目细节**（某功能怎么实现、某数据存在哪、某命令做什么、测试覆盖了什么）：直接读代码和文档后回答，引用具体文件和行号。不改文件、不跑构建或整套测试、不建分支、不提交、不建 PR。确实需要运行某个命令才能确认答案时，只跑只读、快速的命令，并说明结果来自实际运行。
- **开发或修改功能**（新功能、修 bug、重构、改 UI、改打包或发布流程）：按下面的「开发流程」执行，三步都不能省。

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
| `scripts/macos-installer/` | Swift 图形安装器及其测试 |
| `scripts/desktop-acceptance/` | 隔离验收用的独立 App / DMG 构建脚本 |
| `.github/workflows/release.yml` | 推 `v*` 标签时测试、双架构构建、签名并发布 |

## 开发流程

### 1. 自验证闭环

改完代码不等于完成。每次修改功能都走完这个循环，直到全部通过：

1. **改之前**：读相关代码和已有测试，明确改动影响的路径（前端交互、IPC 命令、数据库、启动、更新、安装器）。修 bug 时先写能复现问题的测试，确认它在修复前失败。
2. **改代码**，同时补测试（见下一节）。
3. **运行**与改动相关的全部检查，再跑一遍完整回归。
4. **实际运行应用**观察行为：UI 改动看截图或真实窗口，后端改动在真实应用里走一遍对应操作。
5. **失败就修**，回到第 3 步。不跳过、不注释掉、不放宽断言来让测试通过；确属测试本身过时才改测试，并说明原因。
6. **如实汇报**：列出实际执行的命令及结果（通过数 / 失败数），哪些没有验证、为什么（例如没有 Intel Mac、没有实体移动硬盘）。没跑过的不写「已验证」。

### 2. 建立实际可运行的测试与构建

新增或修改的行为必须有能实际运行、会在回归时失败的测试，并且确实运行过。按改动范围选择层级：

**Unit**
- Rust：在对应模块的 `#[cfg(test)] mod tests` 里加测试。
- 前端：在 `scripts/test-*.cjs` 中新增或扩展测试。沿用现有写法：`fs.readFileSync` 读取 `frontend/` 源码，`vm` 运行所需片段，注入假的 DOM / `invoke`。新文件命名为 `scripts/test-<功能>.cjs`，会被 CI 的 `node --test scripts/test-*.cjs` 自动收入。

**Integration**
- 命令与数据库：`src-tauri/src/commands_regression_tests.rs`，用临时目录里的真实 SQLite 和真实音频文件（`tempfile`、`hound`）。
- schema 变化：在 `db_upgrade_tests.rs` 覆盖从所有历史版本 fixture 升级；发布新 schema 时在 `src-tauri/tests/fixtures/` 补该版本的 SQL。
- 更新清单：`scripts/test-update-manifest.py`；安装器：`scripts/macos-installer/tests/main.swift`。

**核心 E2E**
- UI 与交互：生成预览页后用无头 Chrome 截图，并读取截图确认结果：
  ```bash
  node frontend/.preview/build-preview.cjs frontend/index.html frontend/preview.html
  (cd frontend && python3 -m http.server 8931) &
  node frontend/.preview/shot.mjs "#<hash>" /tmp/mm-shot.png 2500 1440 900 "<可选的页面内 JS>"
  ```
  `shot.mjs` 会输出页面异常和 console error，有输出就要处理。新增后端命令时同步更新 `mock-tauri.js`，否则预览会失效。
- 涉及 Tauri / 文件系统 / 数据库 / 启动 / 更新的改动，预览的 mock 不够，需用 `cd src-tauri && cargo tauri dev` 在真实窗口验证。
- 启动、音乐库切换、更新、安装器等高风险改动，参照 `docs/startup-validation-v0.2.5.md` 和 `scripts/desktop-acceptance/` 的方式，使用独立 identifier 和 `/private/tmp` 下的隔离目录验收。

**完整回归（提交前必须全部通过）**
```bash
node --check frontend/app.js
node --check frontend/updater.js
node --test scripts/test-*.cjs
python3 scripts/test-update-manifest.py
(cd src-tauri && cargo test --locked --lib)
```
改动安装器或打包脚本时加跑 `bash scripts/test-macos-installer.sh`。

**必要构建**
- 改了 Rust 代码：至少 `(cd src-tauri && cargo build --locked)` 通过。
- 改了打包、签名、`tauri.conf.json`、`Info.plist`、图标、`Cargo.toml` 依赖或更新逻辑：运行
  `(cd src-tauri && cargo tauri build --bundles app --target aarch64-apple-darwin)`，需要时再用 `scripts/build-macos-installer.sh` 构建 DMG（命令见 README「打包」）。
- 纯前端改动不需要 Rust 构建，但要通过上面的 `node --check` 和预览 E2E。

### 3. 提交与 PR

- **用户明确授权提交后**才 commit；没有授权时只汇报改动和验证结果，然后询问。
- 当前在 `main` 时，先建分支（如 `feat/<简述>`、`fix/<简述>`），不直接提交到 `main`。只暂存本次改动相关的文件，不要顺带提交工作区里其他无关修改。
- 推送分支后创建 PR（`gh pr create`；本机未装 `gh` 时先 `brew install gh && gh auth login`）。PR 描述包含：
  - **改动**：做了什么、为什么、影响哪些模块，数据库 schema / 用户数据是否受影响。
  - **实际验证结果**：执行的命令和真实输出摘要（通过数 / 失败数）、E2E 截图或真实窗口的验证情况、构建是否成功。
  - **未验证 / 风险**：没覆盖到的场景和原因。
- **不自动合并**：不执行 `gh pr merge`、不开启 auto-merge，由用户手动合并。
- 不推送 `v*` 标签：标签会触发 `release.yml` 正式发布，只在用户明确要求发布时操作。

## 必须遵守的约束

- **不碰用户真实数据**：开发和测试不读写 `~/Library/Application Support/com.musicmanager.app/` 下的正式配置与 `library.db`，也不修改用户的原始音频文件。测试用临时目录；真实窗口验收用独立 identifier（参照 `scripts/desktop-acceptance/build-fixture.py`）。
- **数据安全**：删除音乐或片段只删记录，不删音频文件。数据库升级必须先备份、在单个事务中迁移并校验，失败整体回滚；音乐库不可用时等待重试，不创建替代空库。
- **前端不引入 npm 包或构建步骤**，保持原生 JS；第三方代码放在 `frontend/vendor/`。
- **版本号**：发布时同步修改 `src-tauri/Cargo.toml`、`Cargo.lock`、`src-tauri/tauri.conf.json`，CI 会校验三者与标签一致。普通功能修改不要改版本号。
- 改了用户可见的行为、命令或测试入口时，同步更新 `README.md`。
