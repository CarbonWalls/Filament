/// Backend plugin registry.
///
/// Two plugin kinds exist:
/// - `wasm`  — a .wasm component loaded into wasmtime, capability-gated.
/// - `subprocess` — an executable speaking line records over stdio (explicit
///   opt-in in plugin.toml). Listed here for completeness; not spawned unless
///   the manifest opts in.
///
/// A plugin participates in the FS through hooks. Filament routes any path
/// containing `!/` (e.g. `/home/me/a.zip!/docs`) to the plugin whose
/// `matches` glob claims the archive part.
use crate::db::Entry;
use crate::wasmhost::{Plugin, PluginInstance};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Serialize)]
pub struct Manifest {
    pub id: String,
    pub version: String,
    pub kind: String, // "wasm" | "subprocess"
    pub capabilities: Vec<String>,
    pub hooks: Vec<String>,
    pub matches: Vec<String>,
}

enum Backend {
    Wasm(Plugin),
    #[allow(dead_code)]
    Subprocess { cmd: String },
}

struct Loaded {
    manifest: Manifest,
    backend: Backend,
}

pub struct Registry {
    plugins: Vec<Mutex<LoadedSlot>>,
}

struct LoadedSlot {
    manifest: Manifest,
    backend: Backend,
    instance: Option<PluginInstance>,
}

fn parse_manifest(dir: &Path) -> Option<(Manifest, PathBuf)> {
    let raw = std::fs::read_to_string(dir.join("plugin.toml")).ok()?;
    let val: toml::Value = raw.parse().ok()?;
    let s = val.as_table()?;
    let get_list = |key: &str| -> Vec<String> {
        s.get(key)
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default()
    };
    let manifest = Manifest {
        id: s.get("id")?.as_str()?.to_string(),
        version: s.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0").to_string(),
        capabilities: get_list("capabilities"),
        hooks: get_list("hooks"),
        matches: get_list("matches"),
        kind: String::new(),
    };
    let wasm = dir.join("plugin.wasm");
    let kind = if wasm.exists() {
        "wasm"
    } else if s.get("main").and_then(|v| v.as_str()).is_some() {
        "subprocess"
    } else {
        return None;
    };
    Some((
        Manifest {
            kind: kind.to_string(),
            ..manifest
        },
        wasm,
    ))
}

/// Suffix glob: "*.zip" matches "a.zip", "deep/a.ZIP" via case folding.
fn glob_match(pattern: &str, path: &str) -> bool {
    let p = pattern.to_ascii_lowercase();
    let t = path.to_ascii_lowercase();
    if let Some(suffix) = p.strip_prefix('*') {
        t.ends_with(suffix)
    } else {
        t == p
    }
}

impl Registry {
    /// Loads every plugin under `<exe dir>/plugins` and `./plugins`.
    pub fn load() -> Self {
        let mut roots = vec![PathBuf::from("plugins")];
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                roots.push(parent.join("plugins"));
            }
        }
        let mut plugins = Vec::new();
        for root in roots {
            let Ok(rd) = std::fs::read_dir(&root) else { continue };
            for entry in rd.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let Some((manifest, wasm_path)) = parse_manifest(&dir) else {
                    continue;
                };
                match manifest.kind.as_str() {
                    "wasm" => match Plugin::load(&wasm_path) {
                        Ok(plugin) => {
                            eprintln!(
                                "plugin '{}' v{} loaded (wasm, caps: {:?})",
                                manifest.id, manifest.version, manifest.capabilities
                            );
                            plugins.push(Mutex::new(LoadedSlot {
                                manifest: manifest.clone(),
                                backend: Backend::Wasm(plugin),
                                instance: None,
                            }));
                        }
                        Err(e) => eprintln!("plugin '{}' failed to load: {e}", manifest.id),
                    },
                    "subprocess" => {
                        eprintln!(
                            "plugin '{}' is a subprocess plugin; not started (opt-in only)",
                            manifest.id
                        );
                    }
                    _ => {}
                }
            }
        }
        Self { plugins }
    }

    pub fn manifest_summaries(&self) -> Vec<Manifest> {
        self.plugins
            .iter()
            .map(|p| p.lock().unwrap().manifest.clone())
            .collect()
    }

    fn find_for(&self, hook: &str, path: &str) -> Option<usize> {
        self.plugins.iter().position(|p| {
            let slot = p.lock().unwrap();
            slot.manifest.hooks.iter().any(|h| h == hook)
                && slot.manifest.matches.iter().any(|m| glob_match(m, path))
        })
    }

    /// `list` hook: entries inside an archive (virtual filesystem).
    pub fn plugin_list(&self, archive: &str, inner: &str) -> Result<Vec<Entry>, String> {
        let idx = self
            .find_for("list", archive)
            .ok_or_else(|| format!("no plugin handles {archive}"))?;
        let slot = self.plugins[idx].lock().unwrap();
        let mut slot = slot;
        let req = format!("list\t{archive}\t{}\n", inner.trim_matches('/'));
        let bytes = self.with_instance(&mut slot, archive, |inst| inst.call(&req))?;
        parse_entry_lines(&bytes)
    }

    /// `read` hook: raw bytes of a file inside an archive.
    pub fn plugin_read(&self, archive: &str, inner: &str) -> Result<Vec<u8>, String> {
        let idx = self
            .find_for("read", archive)
            .ok_or_else(|| format!("no plugin handles {archive}"))?;
        let slot = self.plugins[idx].lock().unwrap();
        let mut slot = slot;
        let req = format!("read\t{archive}\t{}\n", inner.trim_matches('/'));
        let bytes = self.with_instance(&mut slot, archive, |inst| inst.call(&req))?;
        let mut lines = bytes.splitn(2, |&b| b == b'\n');
        let status = lines.next().unwrap_or(b"err");
        if status == b"ok" {
            Ok(lines.next().unwrap_or(&[]).to_vec())
        } else {
            Err(String::from_utf8_lossy(lines.next().unwrap_or(b"failed")).to_string())
        }
    }

    /// Lazily instantiate (and reuse) the wasm instance with the archive
    /// context set so capability checks can bind reads to this archive.
    fn with_instance(
        &self,
        slot: &mut LoadedSlot,
        archive: &str,
        f: impl FnOnce(&mut PluginInstance) -> Result<Vec<u8>, String>,
    ) -> Result<Vec<u8>, String> {
        let Backend::Wasm(plugin) = &slot.backend else {
            return Err("subprocess plugin invoke not enabled".into());
        };
        if slot.instance.is_none() {
            slot.instance = Some(
                plugin
                    .instantiate(slot.manifest.capabilities.clone())
                    .map_err(|e| format!("plugin init failed: {e}"))?,
            );
        }
        let inst = slot.instance.as_mut().unwrap();
        inst.set_archive(Some(archive.to_string()));
        let r = f(inst).map_err(|e| format!("plugin call failed: {e}"));
        inst.set_archive(None);
        r
    }
}

/// Response body after the first status line: `name\tkind\tsize` rows.
fn parse_entry_lines(bytes: &[u8]) -> Result<Vec<Entry>, String> {
    let mut lines = bytes.splitn(2, |&b| b == b'\n');
    let status = lines.next().unwrap_or(b"err");
    if status != b"ok" {
        return Err(String::from_utf8_lossy(
            lines.next().unwrap_or(b"plugin error"),
        )
        .to_string());
    }
    let body = String::from_utf8_lossy(lines.next().unwrap_or(&[]));
    let mut out = Vec::new();
    for line in body.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let name = parts.next().unwrap_or("");
        let kind: u8 = parts.next().and_then(|k| k.parse().ok()).unwrap_or(0);
        let size: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        if name.is_empty() {
            continue;
        }
        out.push(Entry {
            name: name.to_string(),
            kind,
            size,
            mtime: 0,
            ext: crate::list::ext_of(name),
        });
    }
    Ok(out)
}
