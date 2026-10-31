/// WASM plugin host (wasmtime).
///
/// ABI (deliberately tiny, no component-model tooling needed):
/// - guest exports: `memory`, `alloc(len: i32) -> i32`, `handle(ptr: i32, len: i32) -> i32`
/// - guest imports: `env.host(ptr: i32, len: i32) -> i32`
/// - strings are passed as a 4-byte little-endian length header followed by
///   the body (for host→guest responses) or as ptr+len args (guest→host
///   requests, and the handle() call). Bodies are UTF-8 line records, not
///   JSON, so plugins can stay `no_std` with zero dependencies.
///
/// Capability enforcement happens inside `dispatch`: the plugin can only ask
/// the host for things its plugin.toml declares (e.g. `fs:read`), and even
/// then only for paths the host itself handed it in this call chain.
use wasmtime::{Caller, Engine, Func, Linker, Memory, Module, Store};

pub struct Plugin {
    engine: Engine,
    module: Module,
}

pub struct PluginInstance {
    store: Store<HostState>,
    handle: Func,
    alloc: Func,
    memory: Memory,
}

pub struct HostState {
    pub capabilities: Vec<String>,
    /// The archive path the daemon is currently browsing through this plugin.
    /// `fs:read` requests are restricted to exactly this path.
    pub current_archive: Option<String>,
    pub log: Vec<String>,
}

impl Plugin {
    pub fn load(wasm_path: &std::path::Path) -> Result<Self, String> {
        let engine = Engine::default();
        let module = Module::from_file(&engine, wasm_path)
            .map_err(|e| format!("wasm load failed: {e}"))?;
        Ok(Self { engine, module })
    }

    pub fn instantiate(&self, capabilities: Vec<String>) -> Result<PluginInstance, String> {
        let mut linker: Linker<HostState> = Linker::new(&self.engine);
        linker.func_wrap(
            "env",
            "host",
            |mut caller: Caller<'_, HostState>, ptr: i32, len: i32| -> i32 {
                let (mem, req) = {
                    let memory = caller
                        .get_export("memory")
                        .and_then(|e| e.into_memory())
                        .expect("guest memory");
                    let mut buf = vec![0u8; len.max(0) as usize];
                    memory
                        .read(&caller, ptr.max(0) as usize, &mut buf)
                        .expect("read guest memory");
                    (memory, buf)
                };
                let resp = caller.data_mut().dispatch(&req);
                write_guest(&mut caller, &mem, &resp).unwrap_or(0)
            },
        )
        .map_err(|e| format!("host import bind failed: {e}"))?;

        let mut store = Store::new(&self.engine, HostState {
            capabilities,
            current_archive: None,
            log: Vec::new(),
        });
        let instance = linker
            .instantiate(&mut store, &self.module)
            .map_err(|e| format!("plugin instantiate failed: {e}"))?;
        let memory = instance.get_memory(&mut store, "memory").ok_or_else(|| {
            "plugin exports no memory".to_string()
        })?;
        let handle = instance
            .get_func(&mut store, "handle")
            .ok_or_else(|| "plugin exports no handle".to_string())?;
        let alloc = instance
            .get_func(&mut store, "alloc")
            .ok_or_else(|| "plugin exports no alloc".to_string())?;
        Ok(PluginInstance {
            store,
            handle,
            alloc,
            memory,
        })
    }
}

/// Write `bytes` (with 4-byte LE length header) into guest memory using the
/// guest's own `alloc`. Returns the guest pointer, or 0 on failure.
fn write_guest(
    caller: &mut Caller<'_, HostState>,
    mem: &Memory,
    bytes: &[u8],
) -> Result<i32, String> {
    let alloc = caller
        .get_export("alloc")
        .and_then(|e| e.into_func())
        .ok_or_else(|| "plugin exports no alloc".to_string())?;
    let total = (bytes.len() + 4) as i32;
    let mut typed = alloc
        .typed::<i32, i32>(&caller)
        .map_err(|e: wasmtime::Error| e.to_string())?;
    let ptr = typed
        .call(&mut *caller, total)
        .map_err(|e: wasmtime::Error| e.to_string())?;
    let mut buf = Vec::with_capacity(bytes.len() + 4);
    buf.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(bytes);
    mem.write(&mut *caller, ptr.max(0) as usize, &buf)
        .map_err(|e: wasmtime::MemoryAccessError| e.to_string())?;
    Ok(ptr)
}

impl HostState {
    /// Handle one host-call from the plugin: line records in, line records out.
    fn dispatch(&mut self, req: &[u8]) -> Vec<u8> {
        let text = String::from_utf8_lossy(req);
        let mut lines = text.lines();
        let op = lines.next().unwrap_or("").trim();
        let arg1 = lines.next().unwrap_or("").trim().to_string();
        let _arg2 = lines.next().unwrap_or("").trim().to_string();

        let allowed = |cap: &str| self.capabilities.iter().any(|c| c == cap);
        match (op, &self.current_archive) {
            ("read_file", Some(archive)) if allowed("fs:read") => {
                // Only the archive currently being browsed may be read.
                if arg1 != *archive {
                    return err("fs:read denied for path outside current archive");
                }
                match std::fs::read(&arg1) {
                    Ok(bytes) => {
                        let mut out = b"ok\n".to_vec();
                        out.extend_from_slice(&bytes);
                        out
                    }
                    Err(e) => err(&format!("read failed: {e}")),
                }
            }
            ("read_file", _) => err("fs:read not granted or no archive context"),
            ("log", _) => {
                self.log.push(arg1);
                b"ok\n".to_vec()
            }
            _ => err(&format!("unknown op '{op}'")),
        }
    }
}

fn err(msg: &str) -> Vec<u8> {
    let mut v = b"err\n".to_vec();
    v.extend_from_slice(msg.as_bytes());
    v
}

impl PluginInstance {
    /// Invoke the plugin's `handle` with a line-record request, return the
    /// response body (everything after the first status line).
    pub fn call(&mut self, request: &str) -> Result<Vec<u8>, String> {
        // Write request into guest memory.
        let req = request.as_bytes();
        let mut alloc_typed = self
            .alloc
            .typed::<i32, i32>(&self.store)
            .map_err(|e| e.to_string())?;
        let ptr = alloc_typed
            .call(&mut self.store, req.len() as i32)
            .map_err(|e| e.to_string())?;
        self.memory
            .write(&mut self.store, ptr as usize, req)
            .map_err(|e| e.to_string())?;

        // Call handle.
        let mut handle_typed = self
            .handle
            .typed::<(i32, i32), i32>(&self.store)
            .map_err(|e| e.to_string())?;
        let ret = handle_typed
            .call(&mut self.store, (ptr, req.len() as i32))
            .map_err(|e| e.to_string())?;

        // Read length-headered response.
        let mut header = [0u8; 4];
        self.memory
            .read(&self.store, ret as usize, &mut header)
            .map_err(|e| e.to_string())?;
        let len = u32::from_le_bytes(header) as usize;
        let mut body = vec![0u8; len.min(256 * 1024 * 1024)];
        self.memory
            .read(&self.store, ret as usize + 4, &mut body)
            .map_err(|e| e.to_string())?;
        Ok(body)
    }

    pub fn set_archive(&mut self, archive: Option<String>) {
        self.store.data_mut().current_archive = archive;
    }
}
