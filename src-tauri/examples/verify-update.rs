#[cfg(target_os = "macos")]
fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert!(args.len()==3 || args.len()==5, "Usage: verify-update FILE SIGNATURE_FILE [--trusted-key FILE]");
    let trusted=if args.len()==5 {assert_eq!(args[3],"--trusted-key");std::fs::read_to_string(&args[4]).expect("read trusted release key")} else {include_str!("../updater-public-key.txt").to_owned()};
    let bytes = std::fs::read(&args[1]).expect("read update");
    let signature = std::fs::read_to_string(&args[2]).expect("read signature");
    music_manager_lib::updater::verify_cached(
        &bytes, &signature, &trusted,
    ).expect("signature must match the public key shipped in the app");
    println!("Update signature verified");
}
#[cfg(not(target_os = "macos"))]
fn main() { panic!("Use the macOS release runner"); }
