//! Movie identities and music/movie associations. All writes are transactional.
use super::*;
use rusqlite::Connection;
use unicode_normalization::UnicodeNormalization;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Movie {
    pub id: i64,
    pub name: String,
    pub music_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovieMatch {
    pub movie: Movie,
    pub already_linked: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageWriteResult {
    pub added: usize,
    pub already_linked: usize,
    pub missing_music: usize,
}

pub(super) fn movie_name(name: &str) -> Result<(String, String), String> {
    let name = name.trim().to_string();
    let key: String = name.nfkc().flat_map(char::to_lowercase).collect();
    if key.trim().is_empty() {
        return Err("请输入电影名称".into());
    }
    Ok((name, key))
}

pub(super) fn get_movie_in(conn: &Connection, id: i64) -> Result<Option<Movie>, String> {
    conn.query_row("SELECT f.id,f.name,(SELECT COUNT(*) FROM music_movie_usages WHERE movie_id=f.id) FROM movies f WHERE f.id=?1", [id], |row| Ok(Movie { id: row.get(0)?, name: row.get(1)?, music_count: row.get(2)? }))
        .optional().map_err(|e| format!("读取电影失败：{e}"))
}

#[tauri::command]
pub fn get_movie(state: tauri::State<'_, AppState>, id: i64) -> Result<Option<Movie>, String> {
    let conn = lock_db!(state);
    get_movie_in(&conn, id)
}

pub(super) fn create_movie_in(conn: &mut Connection, name: &str) -> Result<Movie, String> {
    let (name, key) = movie_name(name)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO movies(name,name_key,created_at,updated_at) VALUES(?1,?2,?3,?3) ON CONFLICT(name_key) DO NOTHING", params![name,key,now_ms()])
        .map_err(|e| format!("创建电影失败：{e}"))?;
    let id = tx.query_row("SELECT id FROM movies WHERE name_key=?1", [key], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let movie = get_movie_in(&tx, id)?.ok_or("电影已不存在")?;
    tx.commit().map_err(|e| format!("创建电影失败：{e}"))?;
    Ok(movie)
}

#[tauri::command]
pub fn create_movie(state: tauri::State<'_, AppState>, name: String) -> Result<Movie, String> {
    let _operation = crate::operation_gate::WRITES.enter()?;
    let mut conn = lock_db!(state);
    create_movie_in(&mut conn, &name)
}

pub(super) fn delete_movie_in(conn: &mut Connection, movie_id: i64) -> Result<(), String> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM music_movie_usages WHERE movie_id=?1", [movie_id])
        .map_err(|e| format!("清除电影使用记录失败：{e}"))?;
    tx.execute("DELETE FROM movies WHERE id=?1", [movie_id])
        .map_err(|e| format!("删除电影失败：{e}"))?;
    tx.commit().map_err(|e| format!("删除电影失败：{e}"))
}

#[tauri::command]
pub fn delete_movie(state: tauri::State<'_, AppState>, movie_id: i64) -> Result<(), String> {
    let _operation = crate::operation_gate::WRITES.enter()?;
    let mut conn = lock_db!(state);
    delete_movie_in(&mut conn, movie_id)
}

pub(super) fn find_movie_in(
    conn: &Connection,
    name: &str,
    music_id: Option<&str>,
) -> Result<Option<MovieMatch>, String> {
    let (_, key) = movie_name(name)?;
    let id: Option<i64> = conn
        .query_row("SELECT id FROM movies WHERE name_key=?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| format!("查询电影名称失败：{e}"))?;
    match id {
        Some(id) => {
            let already_linked = conn.query_row("SELECT EXISTS(SELECT 1 FROM music_movie_usages WHERE movie_id=?1 AND music_id=?2)", params![id, music_id], |row| row.get(0)).map_err(|e| e.to_string())?;
            Ok(Some(MovieMatch {
                movie: get_movie_in(conn, id)?.ok_or("电影已不存在")?,
                already_linked,
            }))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn find_movie_by_name(
    state: tauri::State<'_, AppState>,
    name: String,
    music_id: Option<String>,
) -> Result<Option<MovieMatch>, String> {
    let conn = lock_db!(state);
    find_movie_in(&conn, &name, music_id.as_deref())
}

fn require_music(conn: &Connection, id: &str) -> Result<(), String> {
    if !conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM music WHERE id=?1)",
            [id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())?
    {
        return Err("音乐已不存在，请刷新后重试".into());
    }
    Ok(())
}
fn require_movie(conn: &Connection, id: i64) -> Result<(), String> {
    if !conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM movies WHERE id=?1)",
            [id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())?
    {
        return Err("电影已不存在，请刷新后重试".into());
    }
    Ok(())
}

pub(super) fn add_movies_in(
    conn: &mut Connection,
    music_id: &str,
    movie_ids: &[i64],
    names: &[String],
    note: &str,
) -> Result<UsageWriteResult, String> {
    if movie_ids.is_empty() && names.is_empty() {
        return Err("请至少选择一部电影".into());
    }
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    require_music(&tx, music_id)?;
    let mut ids: std::collections::BTreeSet<i64> = movie_ids.iter().copied().collect();
    for &id in &ids {
        require_movie(&tx, id)?;
    }
    let now = now_ms();
    for name in names {
        let (name, key) = movie_name(name)?;
        tx.execute("INSERT INTO movies(name,name_key,created_at,updated_at) VALUES(?1,?2,?3,?3) ON CONFLICT(name_key) DO NOTHING", params![name,key,now]).map_err(|e| format!("创建电影失败：{e}"))?;
        ids.insert(
            tx.query_row("SELECT id FROM movies WHERE name_key=?1", [key], |row| {
                row.get(0)
            })
            .map_err(|e| e.to_string())?,
        );
    }
    let mut result = UsageWriteResult::default();
    for id in ids {
        let count = tx.execute("INSERT INTO music_movie_usages(music_id,movie_id,note,created_at,updated_at) VALUES(?1,?2,?3,?4,?4) ON CONFLICT(music_id,movie_id) DO NOTHING", params![music_id,id,note.trim(),now]).map_err(|e| format!("记录电影使用失败：{e}"))?;
        result.added += count;
        result.already_linked += usize::from(count == 0);
    }
    tx.commit().map_err(|e| format!("保存使用记录失败：{e}"))?;
    Ok(result)
}

#[tauri::command]
pub fn add_music_movie_usages(
    state: tauri::State<'_, AppState>,
    music_id: String,
    movie_ids: Vec<i64>,
    new_movie_names: Vec<String>,
    note: String,
) -> Result<UsageWriteResult, String> {
    let _operation = crate::operation_gate::WRITES.enter()?;
    let mut conn = lock_db!(state);
    add_movies_in(&mut conn, &music_id, &movie_ids, &new_movie_names, &note)
}

pub(super) fn add_music_in(
    conn: &mut Connection,
    movie_id: i64,
    music_ids: &[String],
    note: &str,
) -> Result<UsageWriteResult, String> {
    if music_ids.is_empty() {
        return Err("请至少选择一首音乐".into());
    }
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    require_movie(&tx, movie_id)?;
    let ids: std::collections::BTreeSet<&String> = music_ids.iter().collect();
    let json = serde_json::json!(ids).to_string();
    let existing: usize = tx
        .query_row(
            "SELECT COUNT(*) FROM music WHERE id IN (SELECT value FROM json_each(?1))",
            [&json],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let added = tx
        .execute(
            "INSERT INTO music_movie_usages(music_id,movie_id,note,created_at,updated_at)
        SELECT id,?1,?2,?3,?3 FROM music WHERE id IN (SELECT value FROM json_each(?4))
        ON CONFLICT(music_id,movie_id) DO NOTHING",
            params![movie_id, note.trim(), now_ms(), json],
        )
        .map_err(|e| format!("批量关联音乐失败：{e}"))?;
    let result = UsageWriteResult {
        added,
        already_linked: existing - added,
        missing_music: ids.len() - existing,
    };
    tx.commit().map_err(|e| format!("保存使用记录失败：{e}"))?;
    Ok(result)
}

#[tauri::command]
pub fn add_movie_music_usages(
    state: tauri::State<'_, AppState>,
    movie_id: i64,
    music_ids: Vec<String>,
    note: String,
) -> Result<UsageWriteResult, String> {
    let _operation = crate::operation_gate::WRITES.enter()?;
    let mut conn = lock_db!(state);
    add_music_in(&mut conn, movie_id, &music_ids, &note)
}

pub(super) fn rename_movie_in(conn: &Connection, movie_id: i64, name: &str) -> Result<(), String> {
    let (name, key) = movie_name(name)?;
    let changed = conn.execute("UPDATE movies SET name=?1,name_key=?2,updated_at=?3 WHERE id=?4", params![name,key,now_ms(),movie_id]).map_err(|error| {
        if matches!(error, rusqlite::Error::SqliteFailure(ref e, _) if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE) { "已有同名电影，请使用不同的名称".into() }
        else { format!("修改电影名称失败：{error}") }
    })?;
    if changed == 0 {
        return Err("电影已不存在".into());
    }
    Ok(())
}

#[tauri::command]
pub fn update_movie(
    state: tauri::State<'_, AppState>,
    movie_id: i64,
    name: String,
) -> Result<(), String> {
    let _operation = crate::operation_gate::WRITES.enter()?;
    let conn = lock_db!(state);
    rename_movie_in(&conn, movie_id, &name)
}

#[tauri::command]
pub fn update_movie_usage(
    state: tauri::State<'_, AppState>,
    usage_id: i64,
    note: String,
) -> Result<(), String> {
    let _operation = crate::operation_gate::WRITES.enter()?;
    let conn = lock_db!(state);
    let count = conn
        .execute(
            "UPDATE music_movie_usages SET note=?1,updated_at=?2 WHERE id=?3",
            params![note.trim(), now_ms(), usage_id],
        )
        .map_err(|e| format!("保存使用备注失败：{e}"))?;
    if count == 0 {
        return Err("这条使用记录已不存在".into());
    }
    Ok(())
}

#[tauri::command]
pub fn delete_movie_usage(state: tauri::State<'_, AppState>, usage_id: i64) -> Result<(), String> {
    let _operation = crate::operation_gate::WRITES.enter()?;
    let conn = lock_db!(state);
    conn.execute("DELETE FROM music_movie_usages WHERE id=?1", [usage_id])
        .map_err(|e| format!("移除使用记录失败：{e}"))?;
    Ok(())
}
