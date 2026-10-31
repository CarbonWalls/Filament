use rusqlite::Connection;
use std::sync::Arc;
use std::path::PathBuf;
use std::sync::Mutex;

/// Persistent listing cache (SQLite).
///
/// This is what makes phase 1 of the two-phase render possible: the daemon
/// answers with the *previous* listing for a directory immediately, before
/// the fresh readdir finishes. Rows are validated against the directory's
/// own mtime so the client knows whether the skeleton it paints from cache
/// is likely exact or merely plausible.
pub struct Db(Arc<Mutex<Connection>>);

impl Clone for Db {
    fn clone(&self) -> Self {
        Db(self.0.clone())
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Entry {
    pub name: String,
    pub kind: u8, // 0=file 1=dir 2=symlink 3=archive
    pub size: u64,
    pub mtime: u64, // ms since epoch
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ext: Option<String>,
}

fn db_path() -> PathBuf {
    let base = dirs::cache_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    base.join("filament")
}

impl Db {
    pub fn open() -> Self {
        let dir = db_path();
        let _ = std::fs::create_dir_all(&dir);
        let conn = Connection::open(dir.join("index.db")).expect("open sqlite");
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS entries(
                dir       TEXT    NOT NULL,
                name      TEXT    NOT NULL,
                kind      INTEGER NOT NULL,
                size      INTEGER NOT NULL,
                mtime     INTEGER NOT NULL,
                ext       TEXT,
                dir_mtime INTEGER NOT NULL,
                PRIMARY KEY (dir, name)
            );
            CREATE INDEX IF NOT EXISTS entries_dir ON entries(dir);",
        )
        .expect("create schema");
        Db(Arc::new(Mutex::new(conn)))
    }

    /// Cached listing for `dir`, plus the dir mtime it was recorded with.
    pub fn cached(&self, dir: &str) -> Option<(i64, Vec<Entry>)> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT name, kind, size, mtime, ext, dir_mtime FROM entries WHERE dir = ?1")
            .ok()?;
        let rows = stmt
            .query_map([dir], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            })
            .ok()?;
        let mut dir_mtime: Option<i64> = None;
        let mut out = Vec::new();
        for row in rows.flatten() {
            if dir_mtime.is_none() {
                dir_mtime = Some(row.5);
            }
            out.push(Entry {
                name: row.0,
                kind: row.1 as u8,
                size: row.2 as u64,
                mtime: row.3 as u64,
                ext: row.4,
            });
        }
        dir_mtime.map(|m| (m, out))
    }

    /// Replace the cached rows for one directory in a single transaction.
    pub fn put(&self, dir: &str, dir_mtime: i64, entries: &[Entry]) {
        let conn = self.0.lock().unwrap();
        if let Err(e) = (|| -> rusqlite::Result<()> {
            conn.execute("DELETE FROM entries WHERE dir = ?1", [dir])?;
            let mut stmt = conn.prepare_cached(
                "INSERT INTO entries(dir,name,kind,size,mtime,ext,dir_mtime)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
            )?;
            for e in entries {
                if e.name.len() > 255 {
                    continue;
                }
                stmt.execute(rusqlite::params![
                    dir,
                    e.name,
                    e.kind as i64,
                    e.size as i64,
                    e.mtime as i64,
                    e.ext,
                    dir_mtime
                ])?;
            }
            Ok(())
        })() {
            eprintln!("db put: {e}");
        }
    }

    pub fn forget(&self, dir: &str) {
        let _ = self
            .0
            .lock()
            .unwrap()
            .execute("DELETE FROM entries WHERE dir = ?1", [dir]);
    }
}
