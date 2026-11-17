/* Shared actions and pagination for album and movie directories. */
function catalogActionsHTML(kind, item) {
    if (kind === "movie") {
        const name = escapeHTML(item.name);
        return `<div class="catalog-actions" role="group" aria-label="${name}的操作"><button type="button" class="row-text-action" data-movie-action="rename" data-movie-id="${item.id}" aria-label="修改电影《${name}》的名称">修改</button><button type="button" class="row-text-action danger-btn" data-movie-action="delete-movie" data-movie-id="${item.id}" aria-label="删除电影《${name}》">删除</button></div>`;
    }
    if (!item.key) return '<span aria-hidden="true"></span>';
    const name = escapeHTML(item.label || item.key);
    return `<div class="catalog-actions" role="group" aria-label="${name}的操作"><button type="button" class="row-text-action danger-btn" data-delete-album="${escapeHTML(item.key)}" aria-label="删除专辑 ${name}">删除专辑</button></div>`;
}

function catalogPaginationHTML(page, key, noun) {
    return `<footer class="catalog-footer"><span>共 ${page.total} ${noun}</span>${paginationHTML(page, key, noun, { always: true, compact: true })}</footer>`;
}
