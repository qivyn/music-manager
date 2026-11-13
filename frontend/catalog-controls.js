/* Shared actions and pagination for album and movie directories. */
let catalogMenuSequence = 0;
let catalogMenuState = null;

function catalogActionsHTML(kind, item) {
    if (kind === "album" && !item.key) return '<span class="catalog-more-spacer" aria-hidden="true"></span>';
    const id = `catalog-menu-${++catalogMenuSequence}`;
    const name = escapeHTML(kind === "movie" ? item.name : item.label || item.key);
    const actions = kind === "movie"
        ? `<button type="button" class="settings-action" role="menuitem" tabindex="-1" data-movie-action="rename" data-movie-id="${item.id}">修改名称…</button><button type="button" class="settings-action danger-btn" role="menuitem" tabindex="-1" data-movie-action="delete-movie" data-movie-id="${item.id}">删除电影…</button>`
        : `<button type="button" class="settings-action danger-btn" role="menuitem" tabindex="-1" data-delete-album="${escapeHTML(item.key)}">删除专辑…</button>`;
    return `<div class="catalog-actions"><button type="button" class="catalog-more" data-catalog-menu="${id}" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}" aria-label="${name}的更多操作" title="更多操作">⋯</button><div id="${id}" class="theme-menu catalog-menu hidden" role="menu" aria-label="${name}的操作">${actions}</div></div>`;
}

function catalogPaginationHTML(page, key, noun) {
    return `<footer class="catalog-footer"><span>共 ${page.total} ${noun}</span>${paginationHTML(page, key, noun, { always: true, compact: true })}</footer>`;
}

function closeCatalogMenu({ restoreFocus = false } = {}) {
    const current = catalogMenuState;
    if (!current) return;
    catalogMenuState = null;
    current.menu.classList.add("hidden");
    current.container.classList.remove("opens-up");
    current.trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus && current.trigger.isConnected) current.trigger.focus({ preventScroll: true });
}

function openCatalogMenu(trigger, last = false) {
    closeCatalogMenu();
    const menu = $(trigger.dataset.catalogMenu);
    const container = trigger.closest(".catalog-actions");
    if (!menu || !container) return;
    closeMovieUsageFilter();
    catalogMenuState = { trigger, menu, container };
    menu.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
    const viewportBottom = Math.min(window.innerHeight, document.querySelector(".main-scroll-area")?.getBoundingClientRect().bottom ?? window.innerHeight);
    container.classList.toggle("opens-up", trigger.getBoundingClientRect().bottom + menu.getBoundingClientRect().height + 8 > viewportBottom);
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    (last ? items.at(-1) : items[0])?.focus({ preventScroll: true });
}

function handleCatalogMenuClick(event) {
    const trigger = event.target.closest("[data-catalog-menu]");
    if (trigger) {
        event.preventDefault();event.stopPropagation();
        if (catalogMenuState?.trigger === trigger) closeCatalogMenu(); else openCatalogMenu(trigger);
        return true;
    }
    // Preserve the original album/movie action handler and its confirmation flow.
    const action = event.target.closest(".settings-action");
    if (catalogMenuState && action && catalogMenuState.menu.contains(action)) closeCatalogMenu({ restoreFocus: true });
    return false;
}

function setupCatalogControls() {
    const area = $("contentArea");
    area.addEventListener("keydown", event => {
        const trigger = event.target.closest("[data-catalog-menu]");
        if (trigger) {
            if (["Enter", " ", "ArrowDown", "ArrowUp", "Escape"].includes(event.key)) event.stopPropagation();
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault();openCatalogMenu(trigger, event.key === "ArrowUp"); }
            if (event.key === "Escape") { event.preventDefault();closeCatalogMenu({ restoreFocus: true }); }
            return;
        }
        const current = catalogMenuState;
        if (!current || !current.menu.contains(event.target)) return;
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault();closeCatalogMenu({ restoreFocus: true });return; }
        if (event.key === "Tab") { closeCatalogMenu({ restoreFocus: true });return; }
        const items = [...current.menu.querySelectorAll('[role="menuitem"]')];
        const index = items.indexOf(document.activeElement);
        const next = { ArrowDown: (index + 1) % items.length, ArrowUp: (index - 1 + items.length) % items.length, Home: 0, End: items.length - 1 }[event.key];
        if (next !== undefined) { event.preventDefault();items[next]?.focus({ preventScroll: true }); }
    });
    area.addEventListener("focusout", event => {
        if (catalogMenuState && !catalogMenuState.container.contains(event.relatedTarget)) closeCatalogMenu();
    });
    document.addEventListener("click", event => {
        if (catalogMenuState && !catalogMenuState.container.contains(event.target)) closeCatalogMenu();
    });
    document.querySelector(".main-scroll-area")?.addEventListener("scroll", () => closeCatalogMenu(), { passive: true });
    window.addEventListener("resize", () => closeCatalogMenu());
}
