/* Browser preview / VM test adapter only. The desktop app pages in SQLite. */
(function (root) {
    function createLibraryQuery({ music, clips, tags = [], candidates = [] }) {
        const lower = value => String(value || "").toLowerCase();
        const albumKey = value => lower(String(value || "").normalize("NFKC")).replace(/\s+/g, "");
        const assigned = (m, children) => new Set([...(m.tagIds || []), ...children.flatMap(c => c.tagIds || [])]);
        const matches = (m, children, q) => {
            const selected = tags.filter(t => (q.activeTagIds || []).includes(t.id));
            const categories = [...new Set(selected.map(t => t.categoryId))];
            const has = assigned(m, children);
            const descends = (id, rootId, seen = new Set()) => {
                if (id === rootId) return true;
                if (seen.has(id)) return false;
                seen.add(id);
                const parent = tags.find(t => t.id === id)?.parentId;
                return parent != null && descends(parent, rootId, seen);
            };
            if (!categories.every(cat => selected.filter(t => t.categoryId === cat).some(t => [...has].some(id => descends(id, t.id))))) return false;
            const text = lower([m.name,m.fileName,m.album,m.artist,m.genre,m.year,m.path,...(m.tags || [])].join(" "));
            const needle = lower(q.search).trim();
            return !needle || text.includes(needle) || children.some(c => lower([c.name,...(c.tags || [])].join(" ")).includes(needle));
        };
        const compare = (a,b) => lower(a).localeCompare(lower(b), "en") || String(a).localeCompare(String(b), "en");
        const base = q => {
            let rows = [...music];
            if (q.recent === "used") rows = rows.filter(m => m.lastPlayedAt != null).sort((a,b) => b.lastPlayedAt-a.lastPlayedAt || compare(a.id,b.id)).slice(0,100);
            else if (q.recent === "added") rows = rows.sort((a,b) => b.createdAt-a.createdAt || compare(a.id,b.id)).slice(0,100);
            return rows.filter(m => (q.album == null || (m.album || "").trim() === q.album) && (!q.musicId || m.id === q.musicId));
        };
        const rowsFor = q => {
            if (q.kind === "candidates") return candidates.map(c => {
                const id=c.targetId || c.id;
                if (c.kind === "clip") { const clip=clips.find(x=>x.id===id),parent=music.find(x=>x.id===clip?.musicId); return parent ? {...clip,kind:"clip",musicName:parent.name,duration:clip.end-clip.start}:null; }
                const m=music.find(x=>x.id===id);return m ? {...m,kind:"music"}:null;
            }).filter(Boolean);
            const parents = base(q);
            if (q.kind === "clips") return clips.map(clip=>({clip,music:parents.find(m=>m.id===clip.musicId)})).filter(({clip,music:m}) => m && matches(m,q.directTag ? clips.filter(c=>c.musicId===m.id):[clip],q) && (q.tagId==null || (clip.tagIds || []).includes(q.tagId))).sort((a,b)=>compare(a.music.name,b.music.name)||a.clip.start-b.clip.start||compare(a.clip.id,b.clip.id));
            const rows=parents.filter(m=>{
                const children=clips.filter(c=>c.musicId===m.id);
                return matches(m,children,q) && (q.tagId==null || (q.directTag ? (m.tagIds || []).includes(q.tagId):assigned(m,children).has(q.tagId)));
            });
            if (q.kind === "albums" || q.kind === "tags") {
                const groups=new Map();
                for (const m of rows) {
                    const keys=q.kind === "albums" ? [(m.album || "").trim()] : [...assigned(m,clips.filter(c=>c.musicId===m.id))].map(String);
                    for(const key of keys) {
                        const label=q.kind === "albums" ? key || "未设置专辑" : tags.find(t=>String(t.id)===key)?.path || tags.find(t=>String(t.id)===key)?.name || key;
                        if(q.kind === "albums" && !albumKey(label).includes(albumKey(q.albumSearch))) continue;
                        const group=groups.get(key)||{key,label,count:0};group.count++;groups.set(key,group);
                    }
                }
                return [...groups.values()].sort((a,b)=>compare(a.label,b.label)||compare(a.key,b.key));
            }
            rows.sort((a,b)=>q.recent === "used" ? b.lastPlayedAt-a.lastPlayedAt||compare(a.id,b.id) : (q.newest || q.recent ? b.createdAt-a.createdAt:a.createdAt-b.createdAt)||compare(a.id,b.id));
            return rows.map((m,index)=>({...m,coverArt:"",clipCount:clips.filter(c=>c.musicId===m.id).length,libraryPosition:index,libraryTotal:rows.length}));
        };
        return {
            page(q) { const rows=rowsFor(q),pageSize=Math.max(1,Math.min(100,q.pageSize || 50)),total=rows.length,totalPages=Math.max(1,Math.ceil(total/pageSize)),page=Math.min(totalPages,Math.max(1,q.page||1)); return {items:rows.slice((page-1)*pageSize,page*pageSize),page,pageSize,total,totalPages}; },
            neighbor(q,id,direction) {const rows=rowsFor(q),index=rows.findIndex(m=>m.id===id);return index<0 ? null : rows[index+direction] || null;},
            related(ids,album) {return album != null ? music.filter(m=>(m.album||"").trim()===album).map(m=>m.id):clips.filter(c=>ids.includes(c.musicId)).map(c=>c.id);}
        };
    }
    if (typeof module === "object") module.exports = { createLibraryQuery };
    else root.createPreviewLibraryQuery = createLibraryQuery;
})(typeof window === "object" ? window : globalThis);
