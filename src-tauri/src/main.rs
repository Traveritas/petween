#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Hook forwarding runs before any UI / single-instance machinery (forward.rs).
    if args.first().map(String::as_str) == Some("--hook") {
        petween_lib::forward_hook(&args[1..]);
        return;
    }
    // Pack tooling for scripts and agents (cli.rs): talks to the running app, prints JSON.
    if args.first().map(String::as_str) == Some("--pack") {
        std::process::exit(petween_lib::pack_cli(&args[1..]));
    }
    petween_lib::run()
}
