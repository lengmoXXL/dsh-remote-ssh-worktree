//! Command-line entry point for `dsh-remote-agent`.
//!
//! The daemon binds a loopback address by default — with port 0 unless the
//! operator names one, so the plugin never has to agree on a fixed port — and
//! refuses any other interface unless the operator passes `--allow-remote`;
//! confidentiality and integrity for a non-loopback listener are the operator's
//! tunnel, not this process's concern.
//!
//! Once bound it publishes the address it got in the `--state-file`, which is
//! how the plugin discovers the kernel-assigned port, then reports readiness on
//! stdout and serves until it is signalled.
//!
//! @module dsh-remote-agent/main

use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::str::FromStr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::signal::unix::{signal, SignalKind};

use dsh_remote_agent::fs::FsBackend;
use dsh_remote_agent::git::GitBackend;
use dsh_remote_agent::server::{serve, SharedBackends};
use dsh_remote_agent::state;

/// The command line this binary accepts.
const USAGE: &str = "\
usage: dsh-remote-agent [--listen <host:port>] --token-file <path> [--state-file <path>] [--root <dir>] [--allow-remote]

  --listen <host:port>   address to bind; defaults to 127.0.0.1:0, a random loopback port
  --token-file <path>    file holding the shared secret every client presents
  --state-file <path>    file to publish the bound address and this build's identity in
  --root <dir>           existing directory relative paths resolve against
  --allow-remote         permit a non-loopback listener (provide TLS or a tunnel)
  --version              print the build identity and exit
";

/// A fully parsed command line.
struct AgentConfig {
    host: String,
    port: u16,
    token_file: PathBuf,
    state_file: Option<PathBuf>,
    root: Option<String>,
    allow_remote: bool,
}

/// Why the daemon declined to start.
enum CliError {
    /// The command line was malformed; the usage text is worth printing.
    Usage(String),
    /// The environment refused the request.
    Runtime(String),
}

impl CliError {
    /// The process exit code this refusal reports.
    fn code(&self) -> u8 {
        match self {
            CliError::Usage(_) => 2,
            CliError::Runtime(_) => 1,
        }
    }

    /// The message to write to stderr.
    fn message(&self) -> &str {
        match self {
            CliError::Usage(message) | CliError::Runtime(message) => message,
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match run(&argv).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("dsh-remote-agent: {}", error.message());
            if matches!(error, CliError::Usage(_)) {
                eprint!("{USAGE}");
            }
            ExitCode::from(error.code())
        }
    }
}

/// Run the daemon until its listener stops.
/// @param argv - arguments after the executable.
/// @returns nothing once the daemon has been signalled to stop.
async fn run(argv: &[String]) -> Result<(), CliError> {
    if argv
        .iter()
        .any(|argument| argument == "--help" || argument == "-h")
    {
        print!("{USAGE}");
        return Ok(());
    }
    if argv.iter().any(|argument| argument == "--version") {
        println!("dsh-remote-agent {}", state::AGENT_VERSION);
        return Ok(());
    }
    let config = parse_args(argv)?;
    if !is_loopback_host(&config.host) && !config.allow_remote {
        return Err(CliError::Usage(format!(
            "refusing to listen on non-loopback host \"{}\" without --allow-remote",
            config.host
        )));
    }
    let token = read_token(&config.token_file)?;
    let root = match &config.root {
        Some(path) => Some(read_root(path)?),
        None => None,
    };

    let listener = TcpListener::bind((config.host.as_str(), config.port))
        .await
        .map_err(|error| {
            CliError::Runtime(format!(
                "cannot listen on {}:{}: {error}",
                config.host, config.port
            ))
        })?;
    let address = listener
        .local_addr()
        .map_err(|error| CliError::Runtime(format!("cannot read the bound address: {error}")))?;
    if let Some(path) = &config.state_file {
        state::write(path, address.port()).map_err(|error| {
            CliError::Runtime(format!("cannot publish the state file: {error}"))
        })?;
    }

    let shared = Arc::new(SharedBackends {
        fs: Arc::new(FsBackend::new(root.clone())),
        git: Arc::new(GitBackend::new(root)),
        token,
        agent_version: state::AGENT_VERSION.to_string(),
    });
    tokio::spawn(serve(listener, shared));
    println!("dsh-remote-agent ready {address}");
    let _ = std::io::stdout().flush();

    let mut terminate = signal(SignalKind::terminate())
        .map_err(|error| CliError::Runtime(format!("cannot watch for SIGTERM: {error}")))?;
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
    Ok(())
}

/// Parse the daemon's command line.
fn parse_args(argv: &[String]) -> Result<AgentConfig, CliError> {
    let mut listen: Option<String> = None;
    let mut token_file: Option<String> = None;
    let mut state_file: Option<String> = None;
    let mut root: Option<String> = None;
    let mut allow_remote = false;
    let mut index = 0;
    while index < argv.len() {
        let option = argv[index].as_str();
        if option == "--allow-remote" {
            allow_remote = true;
            index += 1;
            continue;
        }
        if !matches!(
            option,
            "--listen" | "--token-file" | "--state-file" | "--root"
        ) {
            return Err(CliError::Usage(format!("unknown option \"{option}\"")));
        }
        let value = argv
            .get(index + 1)
            .filter(|value| !value.starts_with("--"))
            .ok_or_else(|| CliError::Usage(format!("missing value for {option}")))?;
        index += 2;
        match option {
            "--listen" => listen = Some(value.clone()),
            "--token-file" => token_file = Some(value.clone()),
            "--state-file" => state_file = Some(value.clone()),
            _ => root = Some(value.clone()),
        }
    }
    let token_file =
        token_file.ok_or_else(|| CliError::Usage("--token-file is required".to_string()))?;
    let (host, port) = parse_listen(listen.as_deref().unwrap_or("127.0.0.1:0"))?;
    Ok(AgentConfig {
        host,
        port,
        token_file: PathBuf::from(token_file),
        state_file: state_file.map(PathBuf::from),
        root,
        allow_remote,
    })
}

/// Parse a `<host>:<port>` bind address, accepting `[<ipv6>]:<port>`.
fn parse_listen(value: &str) -> Result<(String, u16), CliError> {
    let (host, port_text) = if let Some(rest) = value.strip_prefix('[') {
        let end = rest
            .find(']')
            .ok_or_else(|| CliError::Usage(format!("invalid --listen address \"{value}\"")))?;
        let port = rest[end + 1..]
            .strip_prefix(':')
            .ok_or_else(|| CliError::Usage(format!("invalid --listen address \"{value}\"")))?;
        (rest[..end].to_string(), port.to_string())
    } else {
        let separator = value
            .rfind(':')
            .filter(|position| *position > 0)
            .ok_or_else(|| {
                CliError::Usage(format!("--listen must be <host>:<port>, got \"{value}\""))
            })?;
        (
            value[..separator].to_string(),
            value[separator + 1..].to_string(),
        )
    };
    let port = port_text
        .parse::<u16>()
        .map_err(|_| CliError::Usage(format!("invalid --listen port \"{port_text}\"")))?;
    Ok((host, port))
}

/// Whether a bind address is reachable only from this machine.
fn is_loopback_host(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }
    IpAddr::from_str(host).is_ok_and(|address| address.is_loopback())
}

/// Read the shared secret, rejecting an empty file.
fn read_token(path: &Path) -> Result<String, CliError> {
    let token = std::fs::read_to_string(path)
        .map_err(|error| {
            CliError::Runtime(format!(
                "cannot read token file \"{}\": {error}",
                path.display()
            ))
        })?
        .trim()
        .to_string();
    if token.is_empty() {
        return Err(CliError::Runtime(format!(
            "token file \"{}\" is empty",
            path.display()
        )));
    }
    Ok(token)
}

/// Canonicalize the served root, requiring it to exist.
fn read_root(path: &str) -> Result<PathBuf, CliError> {
    if !Path::new(path).is_absolute() {
        return Err(CliError::Usage(format!(
            "--root must be an absolute path, got \"{path}\""
        )));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| CliError::Runtime(format!("cannot resolve --root \"{path}\": {error}")))?;
    let info = std::fs::metadata(&canonical)
        .map_err(|error| CliError::Runtime(format!("cannot read --root \"{path}\": {error}")))?;
    if !info.is_dir() {
        return Err(CliError::Runtime(format!(
            "--root \"{path}\" is not a directory"
        )));
    }
    Ok(canonical)
}
