//! Read-only library browsing. Every persisted list is filtered, counted and
//! paged by SQLite; only the selected page is hydrated and sent over IPC.
use super::*;
use rusqlite::{types::Value, Connection};
use serde_json::{json, Value as Json};
use unicode_normalization::UnicodeNormalization;

const MUSIC_COLUMNS: &str =
    "m.id,m.name,m.file_name,m.path,m.album,m.album_source,m.artist,m.genre,m.year,
    m.channels,m.sample_rate,m.bitrate,m.duration,m.file_size,m.mime_type,'' AS cover_art,
    m.last_played_at,m.play_count,m.created_at,m.updated_at";

#[derive(Default, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LibraryQuery {
    pub kind: String,
    pub search: String,
    pub active_tag_ids: Vec<i64>,
    pub recent: Option<String>,
    pub newest: bool,
    pub album: Option<String>,
    pub album_search: String,
    pub tag_id: Option<i64>,
    pub direct_tag: bool,
    pub music_id: Option<String>,
    pub page: u64,
    pub page_size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPage {
    pub items: Vec<Json>,
    pub page: u64,
    pub page_size: u64,
    pub total: u64,
    pub total_pages: u64,
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    use rusqlite::functions::FunctionFlags;
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    conn.create_scalar_function("mm_lower", 1, flags, |ctx| {
        Ok(ctx.get::<String>(0)?.to_lowercase())
    })?;
    conn.create_scalar_function("mm_album_search", 1, flags, |ctx| {
        Ok(ctx
            .get::<String>(0)?
            .nfkc()
            .flat_map(char::to_lowercase)
            .filter(|c| !c.is_whitespace())
            .collect::<String>())
    })
}

struct QuerySql {
    cte: String,
    order: String,
    values: Vec<Value>,
}
fn bind(values: &mut Vec<Value>, value: impl Into<Value>) -> String {
    values.push(value.into());
    format!("?{}", values.len())
}

fn query_sql(query: &LibraryQuery) -> Result<QuerySql, String> {
    let mut values = Vec::new();
    let mut predicates = Vec::new();
    let is_clip = query.kind == "clips";
    let selected = bind(
        &mut values,
        serde_json::to_string(&query.active_tag_ids).map_err(|e| e.to_string())?,
    );
    let assigned = if is_clip && !query.direct_tag {
        "SELECT tag_id FROM music_tags WHERE music_id=m.id UNION SELECT tag_id FROM clip_tags WHERE clip_id=c.id"
    } else {
        "SELECT tag_id FROM music_tags WHERE music_id=m.id UNION SELECT ct.tag_id FROM clips cl JOIN clip_tags ct ON ct.clip_id=cl.id WHERE cl.music_id=m.id"
    };
    predicates.push(format!(
        "NOT EXISTS (SELECT DISTINCT category_id FROM selected_tags s WHERE NOT EXISTS (
        SELECT 1 FROM descendants d WHERE d.category_id=s.category_id AND d.id IN ({assigned})))"
    ));
    if !query.search.trim().is_empty() {
        let needle = bind(&mut values, query.search.trim().to_lowercase());
        let music_text = "m.name||' '||m.file_name||' '||m.album||' '||m.artist||' '||m.genre||' '||m.year||' '||m.path||' '||
            COALESCE((SELECT group_concat(name,' ') FROM (SELECT t.name FROM music_tags mt JOIN tags t ON t.id=mt.tag_id WHERE mt.music_id=m.id ORDER BY t.name COLLATE NOCASE,t.id)),'')";
        let clip_text = "cl.name||' '||COALESCE((SELECT group_concat(name,' ') FROM (SELECT t.name FROM clip_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.clip_id=cl.id ORDER BY t.name COLLATE NOCASE,t.id)),'')";
        if is_clip && !query.direct_tag {
            let text = clip_text.replace("cl.", "c.");
            predicates.push(format!(
                "instr(mm_lower({music_text}||' '||{text}),{needle})>0"
            ));
        } else {
            predicates.push(format!("(instr(mm_lower({music_text}),{needle})>0 OR EXISTS (
                SELECT 1 FROM clips cl WHERE cl.music_id=m.id AND instr(mm_lower({clip_text}),{needle})>0))"));
        }
    }
    if let Some(album) = &query.album {
        let album = bind(&mut values, album.clone());
        predicates.push(format!("trim(m.album)={album}"));
    }
    if let Some(id) = query.tag_id {
        let id = bind(&mut values, id);
        predicates.push(if query.direct_tag {
            if is_clip {
                format!("EXISTS(SELECT 1 FROM clip_tags WHERE clip_id=c.id AND tag_id={id})")
            } else {
                format!("EXISTS(SELECT 1 FROM music_tags WHERE music_id=m.id AND tag_id={id})")
            }
        } else {
            format!("{id} IN ({assigned})")
        });
    }
    if let Some(id) = &query.music_id {
        let id = bind(&mut values, id.clone());
        predicates.push(format!("m.id={id}"));
    }
    let source = match query.recent.as_deref() {
        Some("used") => "SELECT * FROM music WHERE last_played_at IS NOT NULL ORDER BY last_played_at DESC,id ASC LIMIT 100",
        Some("added") => "SELECT * FROM music ORDER BY created_at DESC,id ASC LIMIT 100",
        Some(_) => return Err("未知的最近列表".into()),
        None => "SELECT * FROM music",
    };
    let common = format!("WITH RECURSIVE selected_tags AS (SELECT id,category_id FROM tags WHERE id IN (SELECT value FROM json_each({selected}))),
        descendants(id,category_id) AS (SELECT id,category_id FROM selected_tags UNION SELECT t.id,d.category_id FROM tags t JOIN descendants d ON t.parent_id=d.id),
        source_music AS ({source})");
    let where_sql = predicates.join(" AND ");
    let (rows, order) = match query.kind.as_str() {
        "music" => (format!("SELECT m.id,m.created_at,m.last_played_at FROM source_music m WHERE {where_sql}"),
            if query.recent.as_deref() == Some("used") { "last_played_at DESC,id ASC" }
            else if query.newest || query.recent.is_some() { "created_at DESC,id ASC" }
            else { "created_at ASC,id ASC" }),
        "clips" => (format!("SELECT c.id,m.name AS music_name,c.start FROM clips c JOIN source_music m ON m.id=c.music_id WHERE {where_sql}"), "music_name COLLATE NOCASE,start ASC,id ASC"),
        "albums" => {
            let needle = bind(&mut values, query.album_search.clone());
            (format!("SELECT trim(m.album) AS id,CASE WHEN trim(m.album)='' THEN '未设置专辑' ELSE trim(m.album) END AS label,COUNT(*) AS count
                FROM source_music m WHERE {where_sql} AND instr(mm_album_search(CASE WHEN trim(m.album)='' THEN '未设置专辑' ELSE trim(m.album) END),mm_album_search({needle}))>0 GROUP BY trim(m.album)"), "label COLLATE NOCASE,id ASC")
        },
        "tags" => (format!("SELECT CAST(t.id AS TEXT) AS id,t.path AS label,COUNT(DISTINCT m.id) AS count FROM source_music m
            JOIN (SELECT music_id,tag_id FROM music_tags UNION SELECT c.music_id,ct.tag_id FROM clips c JOIN clip_tags ct ON ct.clip_id=c.id) a ON a.music_id=m.id
            JOIN tag_paths t ON t.id=a.tag_id WHERE {where_sql} GROUP BY t.id,t.path"), "label COLLATE NOCASE,id ASC"),
        "candidates" => ("SELECT e.target_id AS id,e.kind,e.created_at FROM candidate_entries e
            WHERE (e.kind='music' AND EXISTS(SELECT 1 FROM music m WHERE m.id=e.target_id))
               OR (e.kind='clip' AND EXISTS(SELECT 1 FROM clips c JOIN music m ON m.id=c.music_id WHERE c.id=e.target_id))".into(), "created_at ASC,id ASC"),
        _ => return Err("未知的音乐库查询".into()),
    };
    let cte = format!("{common},tag_paths(id,path) AS (SELECT id,name FROM tags WHERE parent_id IS NULL UNION ALL
        SELECT t.id,p.path||' / '||t.name FROM tags t JOIN tag_paths p ON t.parent_id=p.id),rows AS ({rows})");
    Ok(QuerySql {
        cte,
        order: order.into(),
        values,
    })
}

fn tags_for(
    conn: &Connection,
    ids: &[String],
    table: &str,
    column: &str,
) -> Result<HashMap<String, (Vec<String>, Vec<i64>)>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT j.{column},t.name,t.id FROM {table} j JOIN tags t ON t.id=j.tag_id
        WHERE j.{column} IN (SELECT value FROM json_each(?1)) ORDER BY t.name COLLATE NOCASE,t.id"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([json!(ids).to_string()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut map: HashMap<String, (Vec<String>, Vec<i64>)> = HashMap::new();
    for row in rows {
        let (id, name, tag) = row.map_err(|e| e.to_string())?;
        let entry = map.entry(id).or_default();
        entry.0.push(name);
        entry.1.push(tag);
    }
    Ok(map)
}

fn music_by_ids(conn: &Connection, ids: &[String]) -> Result<HashMap<String, Json>, String> {
    let mut tags = tags_for(conn, ids, "music_tags", "music_id")?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {MUSIC_COLUMNS},(SELECT COUNT(*) FROM clips WHERE music_id=m.id) AS clip_count
        FROM music m WHERE m.id IN (SELECT value FROM json_each(?1))"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([json!(ids).to_string()], |r| {
            Ok((Music::from_row(r)?, r.get::<_, i64>("clip_count")?))
        })
        .map_err(|e| e.to_string())?;
    let mut result = HashMap::new();
    for row in rows {
        let (mut item, count) = row.map_err(|e| e.to_string())?;
        let (names, ids) = tags.remove(&item.id).unwrap_or_default();
        item.tags = names;
        item.tag_ids = ids;
        let id = item.id.clone();
        let mut value = json!(item);
        value["clipCount"] = json!(count);
        result.insert(id, value);
    }
    Ok(result)
}

fn clips_by_ids(conn: &Connection, ids: &[String]) -> Result<HashMap<String, Clip>, String> {
    let mut tags = tags_for(conn, ids, "clip_tags", "clip_id")?;
    let mut stmt = conn
        .prepare("SELECT * FROM clips WHERE id IN (SELECT value FROM json_each(?1))")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([json!(ids).to_string()], Clip::from_row)
        .map_err(|e| e.to_string())?;
    let mut result = HashMap::new();
    for row in rows {
        let mut clip = row.map_err(|e| e.to_string())?;
        let (names, ids) = tags.remove(&clip.id).unwrap_or_default();
        clip.tags = names;
        clip.tag_ids = ids;
        result.insert(clip.id.clone(), clip);
    }
    Ok(result)
}

pub(super) fn query_page_in(
    conn: &Connection,
    query: &LibraryQuery,
) -> Result<LibraryPage, String> {
    configure(conn).map_err(|e| e.to_string())?;
    // Keep COUNT, page clamping and hydration on the same SQLite read snapshot.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut sql = query_sql(query)?;
    let total: u64 = tx
        .query_row(
            &format!("{} SELECT COUNT(*) FROM rows", sql.cte),
            params_from_iter(sql.values.iter()),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let page_size = if query.page_size == 0 {
        50
    } else {
        query.page_size.clamp(1, 100)
    };
    let total_pages = total.div_ceil(page_size).max(1);
    let page = query.page.max(1).min(total_pages);
    let limit = bind(&mut sql.values, page_size as i64);
    let offset = bind(&mut sql.values, ((page - 1) * page_size) as i64);
    let select = match query.kind.as_str() {
        "albums" | "tags" => "id,label,count",
        "candidates" => "id,kind",
        _ => "id",
    };
    let rows = {
        let mut stmt = tx
            .prepare(&format!(
                "{} SELECT {select} FROM rows ORDER BY {} LIMIT {limit} OFFSET {offset}",
                sql.cte, sql.order
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(sql.values.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1).unwrap_or_default(),
                    r.get::<_, i64>(2).unwrap_or(0),
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let ids: Vec<_> = rows.iter().map(|r| r.0.clone()).collect();
    let items = match query.kind.as_str() {
        "albums" | "tags" => rows
            .into_iter()
            .map(|(key, label, count)| json!({"key":key,"label":label,"count":count}))
            .collect(),
        "music" => {
            let mut music = music_by_ids(&tx, &ids)?;
            ids.iter()
                .enumerate()
                .filter_map(|(index, id)| {
                    music.remove(id).map(|mut item| {
                        item["libraryPosition"] = json!((page - 1) * page_size + index as u64);
                        item["libraryTotal"] = json!(total);
                        item
                    })
                })
                .collect()
        }
        "clips" => {
            let mut clips = clips_by_ids(&tx, &ids)?;
            let music = music_by_ids(
                &tx,
                &clips
                    .values()
                    .map(|c| c.music_id.clone())
                    .collect::<Vec<_>>(),
            )?;
            ids.iter()
                .filter_map(|id| clips.remove(id))
                .map(|clip| json!({"music":music[&clip.music_id],"clip":clip}))
                .collect()
        }
        "candidates" => {
            let mut clips = clips_by_ids(
                &tx,
                &rows
                    .iter()
                    .filter(|r| r.1 == "clip")
                    .map(|r| r.0.clone())
                    .collect::<Vec<_>>(),
            )?;
            let mut music_ids: Vec<_> = rows
                .iter()
                .filter(|r| r.1 == "music")
                .map(|r| r.0.clone())
                .collect();
            music_ids.extend(clips.values().map(|c| c.music_id.clone()));
            let music = music_by_ids(&tx, &music_ids)?;
            rows.into_iter()
                .map(|(id, kind, _)| {
                    if let Some(clip) = clips.remove(&id) {
                        let parent = &music[&clip.music_id];
                        let mut v = json!(clip);
                        v["kind"] = json!("clip");
                        v["musicName"] = parent["name"].clone();
                        v["duration"] = json!(clip.end - clip.start);
                        v
                    } else {
                        let mut v = music[&id].clone();
                        v["kind"] = json!(kind);
                        v
                    }
                })
                .collect()
        }
        _ => unreachable!(),
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(LibraryPage {
        items,
        page,
        page_size,
        total,
        total_pages,
    })
}

#[tauri::command]
pub fn query_library_page(
    state: tauri::State<'_, AppState>,
    query: LibraryQuery,
) -> Result<LibraryPage, String> {
    let conn = lock_db!(state);
    query_page_in(&conn, &query)
}

#[tauri::command]
pub fn query_music_neighbor(
    state: tauri::State<'_, AppState>,
    query: LibraryQuery,
    id: String,
    direction: i64,
) -> Result<Option<Json>, String> {
    if query.kind != "music" || ![-1, 1].contains(&direction) {
        return Err("无效的播放顺序查询".into());
    }
    let conn = lock_db!(state);
    configure(&conn).map_err(|e| e.to_string())?;
    let mut sql = query_sql(&query)?;
    let current = bind(&mut sql.values, id);
    let direction = bind(&mut sql.values, direction);
    let found: Option<(String,i64,i64)>=conn.query_row(&format!("{},ordered AS (SELECT id,row_number() OVER (ORDER BY {}) AS n FROM rows)
        SELECT id,n,(SELECT COUNT(*) FROM rows) FROM ordered WHERE n=(SELECT n FROM ordered WHERE id={current})+{direction}",sql.cte,sql.order),params_from_iter(sql.values.iter()),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
    match found {
        Some((id, position, total)) => {
            let mut item = music_by_ids(&conn, std::slice::from_ref(&id))?
                .remove(&id)
                .ok_or("音乐已移除")?;
            item["libraryPosition"] = json!(position - 1);
            item["libraryTotal"] = json!(total);
            Ok(Some(item))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn library_related_ids(
    state: tauri::State<'_, AppState>,
    music_ids: Vec<String>,
    album: Option<String>,
) -> Result<Vec<String>, String> {
    let conn = lock_db!(state);
    let (sql, value) = match album {
        Some(album) => ("SELECT id FROM music WHERE trim(album)=?1", album),
        None => (
            "SELECT id FROM clips WHERE music_id IN (SELECT value FROM json_each(?1))",
            json!(music_ids).to_string(),
        ),
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([value], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
