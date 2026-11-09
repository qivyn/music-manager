const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = require('./app-source.cjs').readAppSource();
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function navigation() {
    let active = null;
    const renders = [];
    const elements = Object.fromEntries(["searchInput", "pageTitle", "homeTrackTitle", "updateModal"].map(id => [id, {
        id, tagName: id === "searchInput" ? "INPUT" : "DIV", value: "",
        classList: { contains: () => true }, setAttribute() {}, focus() { active = this; }
    }]));
    const buttons = ["all", "home", "clips"].map(view => ({
        dataset: { view }, classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(_, callback) { this.click = callback; }
    }));
    const context = {
        console, state: { currentView: "home" }, $: id => elements[id],
        render: () => new Promise(resolve => renders.push(resolve)),
        renderFilterPanel() {}, renderSidebarTags() {}, resetPagination() {}, closeMusicContextPanels() {},
        clipEditorPanel: { classList: { contains: () => true } },
        document: {
            querySelectorAll: () => buttons,
            querySelector: selector => buttons.find(button => selector.includes(`"${button.dataset.view}"`)),
            addEventListener(_, callback) { context.onKey = callback; },
            get activeElement() { return active; }
        }
    };
    vm.createContext(context);
    vm.runInContext(section("function goToViewFromHome(", "let homeTracks ="), context);
    vm.runInContext(section("    /* 左侧导航 */", "    /* sidebar tag 树"), context);
    vm.runInContext(section('    document.addEventListener("keydown", event => {\n        const isTyping', "    /* Modal 关闭 */"), context);
    return {
        context, elements, buttons, renders,
        focused: () => active?.id,
        search() { context.onKey({ key: "/", preventDefault() {}, target: { closest: () => null } }); }
    };
}

test("home search keeps input focus after asynchronous navigation finishes", async () => {
    const app = navigation();
    app.search();
    assert.equal(app.context.state.currentView, "all");
    assert.equal(app.focused(), "searchInput");
    app.elements.searchInput.value = "Night";
    app.renders[0]();
    await new Promise(setImmediate);
    assert.equal(app.focused(), "searchInput");
    assert.equal(app.elements.searchInput.value, "Night");
});

test("ordinary navigation still focuses the destination heading", async () => {
    const app = navigation();
    const done = app.buttons[0].click();
    app.renders[0]();
    await done;
    assert.equal(app.focused(), "pageTitle");
});

test("a slow navigation does not steal focus the user moved to search", async () => {
    const app = navigation();
    const done = app.buttons[0].click();
    app.elements.searchInput.focus();
    app.renders[0]();
    await done;
    assert.equal(app.focused(), "searchInput");
});
