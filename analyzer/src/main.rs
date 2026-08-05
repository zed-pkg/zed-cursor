use anyhow::{bail, Context, Result};
use std::env;
use std::path::PathBuf;
use zed_cursor_analyzer::analyze_root;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if arguments.first().map(String::as_str) != Some("analyze") {
        print_help();
        bail!("expected the analyze subcommand");
    }

    let mut root: Option<PathBuf> = None;
    let mut max_manifests = 250usize;
    let mut format = String::from("json");
    let mut index = 1usize;

    while index < arguments.len() {
        match arguments[index].as_str() {
            "--root" => {
                index += 1;
                root = arguments.get(index).map(PathBuf::from);
            }
            "--max-manifests" => {
                index += 1;
                max_manifests = arguments
                    .get(index)
                    .context("--max-manifests requires a value")?
                    .parse()
                    .context("--max-manifests must be a positive integer")?;
            }
            "--format" => {
                index += 1;
                format = arguments
                    .get(index)
                    .context("--format requires a value")?
                    .clone();
            }
            "--help" | "-h" => {
                print_help();
                return Ok(());
            }
            unknown => bail!("unknown argument: {unknown}"),
        }
        index += 1;
    }

    if format != "json" {
        bail!("only --format json is supported");
    }
    let root = root.context("--root is required")?;
    let report = analyze_root(&root, max_manifests)?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}

fn print_help() {
    eprintln!(
        "zed-cursor-analyzer analyze --root <path> [--max-manifests <count>] [--format json]"
    );
}
