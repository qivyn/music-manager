use super::*;

fn library() -> (tempfile::TempDir, rusqlite::Connection) {
    let dir = tempfile::tempdir().unwrap();
    let (_, conn) = crate::db::configure_startup_database(dir.path(), dir.path(), true).unwrap();
    (dir, conn)
}

fn seed_music(conn: &rusqlite::Connection, id: &str, album: &str) {
    conn.execute(
        "INSERT INTO music(id,name,path,album,created_at,updated_at) VALUES(?1,?1,?2,?3,1,1)",
        params![id, format!("/offline/{id}.mp3"), album],
    ).unwrap();
}

fn tag(conn: &rusqlite::Connection, name: &str) -> i64 {
    conn.execute("INSERT INTO tags(name,category_id,created_at) VALUES(?1,(SELECT MIN(id) FROM tag_categories),1)", [name]).unwrap();
    conn.last_insert_rowid()
}

fn update(id: &str, album: &str) -> LocationUpdate {
    LocationUpdate { id: id.into(), path: format!("/new/{id}.mp3"), file_name: format!("{id}.mp3"),
        bookmark: vec![], album: album.into(), source: "folder".into() }
}

fn wav(path: &Path) -> Vec<u8> {
    let mut writer = hound::WavWriter::create(path, hound::WavSpec {
        channels: 1, sample_rate: 8000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int,
    }).unwrap();
    for sample in 0..8000 { writer.write_sample((sample % 1000) as i16).unwrap(); }
    writer.finalize().unwrap();
    fs::read(path).unwrap()
}

fn export(source: &Path, destination: &Path, start: f64, end: f64) -> Result<String, String> {
    export_clip_wav(source.to_string_lossy().into_owned(), start, end, destination.to_string_lossy().into_owned())
}

#[test]
fn export_rejects_the_source_and_preserves_every_byte() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("original.wav");
    let original = wav(&source);
    assert!(export(&source, &source, 0.0, 0.5).unwrap_err().contains("原始"));
    assert_eq!(fs::read(&source).unwrap(), original);
    #[cfg(unix)]
    {
        let symlink = dir.path().join("symlink.wav");
        std::os::unix::fs::symlink(&source, &symlink).unwrap();
        assert!(export(&source, &symlink, 0.0, 0.5).is_err());
        let hardlink = dir.path().join("hardlink.wav");
        fs::hard_link(&source, &hardlink).unwrap();
        assert!(export(&source, &hardlink, 0.0, 0.5).is_err());
        assert_eq!(fs::read(&source).unwrap(), original);
    }
}

#[test]
fn export_publishes_a_complete_wav_and_keeps_existing_output_on_failure() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.wav");
    let original = wav(&source);
    let destination = dir.path().join("output.wav");
    fs::write(&destination, b"previous export").unwrap();
    assert!(export(&source, &destination, 2.0, 3.0).is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"previous export");
    for (start, end) in [(f64::NAN, 1.0), (-1.0, 1.0), (0.0, f64::INFINITY)] {
        assert!(export(&source, &destination, start, end).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"previous export");
    }
    export(&source, &destination, 0.25, 0.75).unwrap();
    assert_eq!(hound::WavReader::open(&destination).unwrap().duration(), 4000);
    assert_eq!(fs::read(&source).unwrap(), original);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2, "temporary files must be removed");
}

#[test]
fn export_stops_before_malformed_mp3_packet_after_selected_interval() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("damaged-tail.mp3");
    let destination = dir.path().join("output.wav");
    // MPEG-1 Layer III, 128 kbps, 44.1 kHz stereo: 417 bytes / 1152 frames per packet.
    // The first packet's zero payload decodes as silence; the second packet has
    // valid framing but malformed side information, so it must not be decoded.
    let mut mp3 = vec![0; 417];
    mp3[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x00]);
    mp3.extend_from_slice(&[0xff, 0xfb, 0x90, 0x00]);
    mp3.extend_from_slice(&[0xff; 413]);
    fs::write(&source, &mp3).unwrap();

    // Prove the fixture actually fails when the selected range needs packet two,
    // rather than silently treating the malformed packet as EOF or valid audio.
    fs::write(&destination, b"previous export").unwrap();
    let error = export(&source, &destination, 0.0, 0.04).unwrap_err();
    assert!(error.contains("解码音频失败"), "unexpected fixture error: {error}");
    assert_eq!(fs::read(&destination).unwrap(), b"previous export");

    // Exercise an interval ending within the first packet and exactly at its end.
    for (start, end, expected_frames) in [(0.0, 0.01, 441), (0.005, 0.01, 221), (0.0, 1152.0 / 44100.0, 1152)] {
        export(&source, &destination, start, end).unwrap();
        let mut reader = hound::WavReader::open(&destination).unwrap();
        assert_eq!(reader.spec().sample_rate, 44_100);
        assert_eq!(reader.spec().channels, 2);
        assert_eq!(reader.spec().bits_per_sample, 16);
        assert_eq!(reader.duration(), expected_frames);
        let samples = reader.samples::<i16>().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(samples.len(), expected_frames as usize * 2);
        assert!(samples.iter().all(|&sample| sample == 0));
    }
    assert_eq!(fs::read(&source).unwrap(), mp3);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2, "temporary files must be removed");
}

#[test]
fn failed_album_tag_writes_roll_back_associations_and_new_tags() {
    let (_dir, mut conn) = library();
    let old = tag(&conn, "保留");
    let other = tag(&conn, "另一个");
    set_album_tags_in(&mut conn, "专辑", &[old], &[]).unwrap();
    assert!(set_album_tags_in(&mut conn, "专辑", &[other, i64::MAX], &[]).is_err());
    assert_eq!(load_tag_ids(&conn, "专辑", "album_tags", "album").unwrap(), vec![old]);
    conn.execute_batch("CREATE TRIGGER reject_tag BEFORE INSERT ON tags WHEN NEW.name='失败' BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    assert!(set_album_tags_in(&mut conn, "专辑", &[], &["临时".into(), "失败".into()]).is_err());
    assert_eq!(load_tag_ids(&conn, "专辑", "album_tags", "album").unwrap(), vec![old]);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM tags WHERE name='临时'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(set_album_tags_in(&mut conn, "专辑", &[other], &[]).unwrap(), vec![other]);
}

#[test]
fn dense_tag_counts_fit_a_linear_sqlite_instruction_budget() {
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    let (_dir, mut conn) = library();
    let used = tag(&conn, "热门");
    let empty = tag(&conn, "空标签");
    let tx = conn.transaction().unwrap();
    for i in 0..1000 {
        let id = format!("m{i}");
        seed_music(&tx, &id, "专辑");
        tx.execute("INSERT INTO music_tags VALUES(?1,?2)", params![id, used]).unwrap();
    }
    for i in 0..500 {
        let id = format!("c{i}");
        tx.execute("INSERT INTO clips VALUES(?1,'m0','片段',0,1,1,1)", params![id]).unwrap();
        tx.execute("INSERT INTO clip_tags VALUES(?1,?2)", params![id, used]).unwrap();
    }
    for i in 0..20 { tx.execute("INSERT INTO album_tags VALUES(?1,?2)", params![format!("a{i}"), used]).unwrap(); }
    tx.commit().unwrap();
    let instructions = Arc::new(AtomicUsize::new(0));
    let counter = instructions.clone();
    // Abort a Cartesian-product regression deterministically, without timing assertions.
    conn.progress_handler(1000, Some(move || counter.fetch_add(1000, Ordering::Relaxed) > 2_000_000));
    let tags = list_tags_in(&conn).unwrap();
    assert_eq!(tags.iter().find(|t| t.id == used).unwrap().music_count, 1520);
    assert_eq!(tags.iter().find(|t| t.id == empty).unwrap().music_count, 0);
}

#[test]
fn moving_one_track_keeps_the_remaining_albums_tags() {
    let (_dir, mut conn) = library();
    seed_music(&conn, "a1", "A"); seed_music(&conn, "a2", "A");
    let id = tag(&conn, "保留");
    set_album_tags_in(&mut conn, "A", &[id], &[]).unwrap();
    apply_location_updates(&mut conn, &[update("a1", "B")]).unwrap();
    assert_eq!(load_tag_ids(&conn, "A", "album_tags", "album").unwrap(), vec![id]);
    assert!(load_tag_ids(&conn, "B", "album_tags", "album").unwrap().is_empty());
}

#[test]
fn complete_album_moves_splits_chains_and_swaps_use_original_tags() {
    for (a_destination, b_destination) in [("B", "C"), ("B", "A"), ("C", "C")] {
        let (_dir, mut conn) = library();
        seed_music(&conn, "a", "A"); seed_music(&conn, "b", "B");
        let a_tag = tag(&conn, "A标签"); let b_tag = tag(&conn, "B标签");
        set_album_tags_in(&mut conn, "A", &[a_tag], &[]).unwrap();
        set_album_tags_in(&mut conn, "B", &[b_tag], &[]).unwrap();
        apply_location_updates(&mut conn, &[update("a", a_destination), update("b", b_destination)]).unwrap();
        assert!(load_tag_ids(&conn, a_destination, "album_tags", "album").unwrap().contains(&a_tag));
        assert!(load_tag_ids(&conn, b_destination, "album_tags", "album").unwrap().contains(&b_tag));
        if a_destination != b_destination {
            assert!(!load_tag_ids(&conn, a_destination, "album_tags", "album").unwrap().contains(&b_tag));
        }
    }
    let (_dir, mut conn) = library();
    seed_music(&conn, "a1", "A"); seed_music(&conn, "a2", "A");
    let id = tag(&conn, "整张专辑");
    set_album_tags_in(&mut conn, "A", &[id], &[]).unwrap();
    apply_location_updates(&mut conn, &[update("a1", "B"), update("a2", "C")]).unwrap();
    for album in ["B", "C"] { assert_eq!(load_tag_ids(&conn, album, "album_tags", "album").unwrap(), vec![id]); }
    assert!(load_tag_ids(&conn, "A", "album_tags", "album").unwrap().is_empty());
}

#[test]
fn location_update_failure_rolls_back_both_tracks_and_album_tags() {
    let (_dir, mut conn) = library();
    seed_music(&conn, "a", "A"); seed_music(&conn, "b", "A");
    let id = tag(&conn, "原标签"); set_album_tags_in(&mut conn, "A", &[id], &[]).unwrap();
    let mut conflicting = update("b", "B"); conflicting.path = "/new/a.mp3".into();
    assert!(apply_location_updates(&mut conn, &[update("a", "B"), conflicting]).is_err());
    assert_eq!(conn.query_row("SELECT album FROM music WHERE id='a'", [], |r| r.get::<_, String>(0)).unwrap(), "A");
    assert_eq!(load_tag_ids(&conn, "A", "album_tags", "album").unwrap(), vec![id]);
}

#[test]
fn offline_metadata_edits_preserve_bookmark_and_rebinding_still_validates_files() {
    let (dir, mut conn) = library();
    seed_music(&conn, "offline", "专辑");
    conn.execute("UPDATE music SET file_bookmark=X'010203' WHERE id='offline'", []).unwrap();
    let music = conn.query_row("SELECT * FROM music WHERE id='offline'", [], Music::from_row).unwrap();
    let mut input: MusicInput = serde_json::from_value(serde_json::to_value(music).unwrap()).unwrap();
    input.name = "离线新名称".into();
    let id = tag(&conn, "离线标签"); input.tag_ids = Some(vec![id]);
    update_music_in(&mut conn, &input).unwrap();
    let stored = conn.query_row("SELECT * FROM music WHERE id='offline'", [], Music::from_row).unwrap();
    assert_eq!(stored.name, "离线新名称");
    assert_eq!(load_tag_ids(&conn, "offline", "music_tags", "music_id").unwrap(), vec![id]);
    assert_eq!(conn.query_row("SELECT file_bookmark FROM music WHERE id='offline'", [], |r| r.get::<_, Vec<u8>>(0)).unwrap(), vec![1,2,3]);
    #[cfg(target_os = "macos")]
    {
        input.path = "/offline/missing-replacement.mp3".into();
        assert!(update_music_in(&mut conn, &input).is_err());
        assert_eq!(conn.query_row("SELECT path FROM music WHERE id='offline'", [], |r| r.get::<_, String>(0)).unwrap(), "/offline/offline.mp3");
    }
    let replacement = dir.path().join("replacement.mp3");
    fs::write(&replacement, b"replacement file").unwrap();
    input.path = replacement.to_string_lossy().into_owned();
    update_music_in(&mut conn, &input).unwrap();
    assert_eq!(conn.query_row("SELECT path FROM music WHERE id='offline'", [], |r| r.get::<_, String>(0)).unwrap(), input.path);
    assert_ne!(conn.query_row("SELECT file_bookmark FROM music WHERE id='offline'", [], |r| r.get::<_, Vec<u8>>(0)).unwrap(), vec![1,2,3]);
}


#[test]
fn sql_pages_filter_before_limiting_and_clamp_after_deletion() {
    use super::library_query::{query_page_in, LibraryQuery};
    let (_dir,conn)=library();
    for i in 0..127 {seed_music(&conn,&format!("m{i:03}"),if i%2==0 {"Ａ 专辑"} else {"Other"});}
    conn.execute("UPDATE music SET name='ÉTÉ 100%_曲' WHERE id='m126'",[]).unwrap();
    let mut q=LibraryQuery {kind:"music".into(),page:2,page_size:10,album:Some("Other".into()),..Default::default()};
    let page=query_page_in(&conn,&q).unwrap();
    assert_eq!((page.total,page.items.len(),page.page),(63,10,2));
    assert_eq!(page.items[0]["id"],"m021");
    assert!(page.items.iter().all(|m|m["coverArt"]==""));
    q.album=None; q.search="été 100%_".into();
    let page=query_page_in(&conn,&q).unwrap();
    assert_eq!((page.total,page.page,page.items.len()),(1,1,1));
    assert_eq!(page.items[0]["id"],"m126");
    q.search="missing".into();
    let page=query_page_in(&conn,&q).unwrap();
    assert_eq!((page.total,page.page,page.total_pages,page.items.len()),(0,1,1,0));
    q.kind="albums".into();q.search.clear();q.album_search="a专辑".into();q.page_size=1;
    let page=query_page_in(&conn,&q).unwrap();
    assert_eq!(page.total,1); assert_eq!(page.items[0]["count"],64);
}

#[test]
fn sql_pages_preserve_tag_dimensions_descendants_and_clip_search() {
    use super::library_query::{query_page_in, LibraryQuery};
    let (_dir,conn)=library();
    seed_music(&conn,"a","Album");seed_music(&conn,"b","Album");
    let root=tag(&conn,"Parent");let child=tag(&conn,"Child");
    conn.execute("UPDATE tags SET parent_id=?1 WHERE id=?2",params![root,child]).unwrap();
    conn.execute("INSERT INTO tag_categories(name,created_at) VALUES('Purpose',1)",[]).unwrap();
    let cat=conn.last_insert_rowid();let other=tag(&conn,"Use");
    conn.execute("UPDATE tags SET category_id=?1 WHERE id=?2",params![cat,other]).unwrap();
    conn.execute("INSERT INTO music_tags VALUES('a',?1)",[child]).unwrap();
    conn.execute("INSERT INTO music_tags VALUES('b',?1)",[child]).unwrap();
    conn.execute("INSERT INTO clips VALUES('clip','a','special phrase',0,2,1,1)",[]).unwrap();
    conn.execute("INSERT INTO clip_tags VALUES('clip',?1)",[other]).unwrap();
    let mut q=LibraryQuery {kind:"music".into(),active_tag_ids:vec![root,other],page_size:1,..Default::default()};
    let page=query_page_in(&conn,&q).unwrap();assert_eq!(page.total,1);assert_eq!(page.items[0]["id"],"a");
    q.active_tag_ids.clear();q.search="special phrase".into();
    assert_eq!(query_page_in(&conn,&q).unwrap().total,1);
    q.kind="clips".into();let page=query_page_in(&conn,&q).unwrap();
    assert_eq!(page.items[0]["music"]["id"],"a");assert_eq!(page.items[0]["clip"]["tagIds"],serde_json::json!([other]));
    q.kind="tags".into();q.search.clear();q.page_size=1;
    let page=query_page_in(&conn,&q).unwrap();assert_eq!(page.total,2);
    assert_eq!(page.items[0]["label"],"Parent / Child");assert_eq!(page.items[0]["count"],2);
}

#[test]
fn sql_recent_and_candidates_have_stable_page_order_and_bounded_payloads() {
    use super::library_query::{query_page_in, LibraryQuery};
    let (_dir,conn)=library();
    for i in 0..105 {let id=format!("m{i:03}");seed_music(&conn,&id,"A");conn.execute("UPDATE music SET created_at=?1,last_played_at=?1 WHERE id=?2",params![i,id]).unwrap();}
    let q=LibraryQuery{kind:"music".into(),recent:Some("used".into()),page:2,page_size:10,..Default::default()};
    let page=query_page_in(&conn,&q).unwrap();assert_eq!(page.total,100);assert_eq!(page.items[0]["id"],"m094");
    conn.execute("INSERT INTO candidate_entries VALUES('m104','music',1)",[]).unwrap();
    conn.execute("INSERT INTO clips VALUES('clip','m104','part',2,5,1,1)",[]).unwrap();
    conn.execute("INSERT INTO candidate_entries VALUES('clip','clip',2)",[]).unwrap();
    let q=LibraryQuery{kind:"candidates".into(),page:2,page_size:1,..Default::default()};
    let page=query_page_in(&conn,&q).unwrap();assert_eq!(page.total,2);assert_eq!(page.items[0]["kind"],"clip");assert_eq!(page.items[0]["duration"],3.0);
}

#[test]
fn sql_search_preserves_alphabetical_tag_phrases() {
    use super::library_query::{query_page_in, LibraryQuery};
    let (_dir, conn) = library();
    seed_music(&conn, "track", "Album");
    let z = tag(&conn, "Zulu");
    let a = tag(&conn, "Alpha");
    conn.execute("INSERT INTO music_tags VALUES('track',?1)", [z]).unwrap();
    conn.execute("INSERT INTO music_tags VALUES('track',?1)", [a]).unwrap();
    let q = LibraryQuery { kind: "music".into(), search: "Alpha Zulu".into(), ..Default::default() };
    assert_eq!(query_page_in(&conn, &q).unwrap().total, 1);
}
