"""ที่เก็บข้อมูล flow ของ Retro Macro Engine (SQLite, ไม่ต้องพึ่ง dependency เพิ่ม)"""
import json
import os
import sqlite3
import sys
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

APP_DIR_NAME = "RetroMacroEngine"
_lock = threading.RLock()  # RLock: save_flow -> _connect -> get_db_path เรียกซ้อนกัน
_db_path = None
_initialized = False


def _candidate_dirs():
    """โฟลเดอร์ที่ใช้เก็บฐานข้อมูล: โฟลเดอร์ตัวแอปก่อน (portable) แล้วค่อย %APPDATA%"""
    if getattr(sys, "frozen", False):
        dirs = [os.path.dirname(sys.executable)]
    else:
        dirs = [os.path.dirname(os.path.abspath(__file__))]
    appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
    dirs.append(os.path.join(appdata, APP_DIR_NAME))
    return dirs


def get_db_path():
    """หาโฟลเดอร์ที่เขียนได้ แล้วคืนพาธไฟล์ flows.db"""
    global _db_path
    with _lock:
        if _db_path:
            return _db_path
        for folder in _candidate_dirs():
            try:
                os.makedirs(folder, exist_ok=True)
                probe = os.path.join(folder, ".write-test")
                with open(probe, "w", encoding="utf-8") as f:
                    f.write("1")
                os.remove(probe)
                _db_path = os.path.join(folder, "flows.db")
                return _db_path
            except OSError:
                continue
        raise RuntimeError("ไม่พบโฟลเดอร์ที่เขียนได้สำหรับเก็บข้อมูล")


def _create_table(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS flows (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL UNIQUE,
            graph      TEXT    NOT NULL,
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_flows_updated ON flows(updated_at DESC)")
    conn.commit()


def init_db():
    """สร้างตารางถ้ายังไม่มี (เรียกอัตโนมัติก่อนใช้งาน)"""
    global _initialized
    with _lock:
        if _initialized:
            return
        conn = sqlite3.connect(get_db_path())
        try:
            _create_table(conn)
        finally:
            conn.close()
        _initialized = True


def _connect():
    init_db()
    conn = sqlite3.connect(get_db_path())
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def _session():
    """เปิดการเชื่อมต่อ SQLite แล้วปิดเสมอ (commit อัตโนมัติ)"""
    conn = _connect()
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def list_flows():
    """คืนรายการ flow ทั้งหมด เรียงตามเวลาแก้ไขล่าสุด"""
    with _session() as conn:
        rows = conn.execute(
            "SELECT id, name, graph, created_at, updated_at FROM flows ORDER BY updated_at DESC"
        ).fetchall()

    result = []
    for r in rows:
        try:
            node_count = len(json.loads(r["graph"]).get("nodes", []))
        except (ValueError, AttributeError):
            node_count = 0
        result.append(
            {
                "id": r["id"],
                "name": r["name"],
                "updated_at": r["updated_at"],
                "created_at": r["created_at"],
                "node_count": node_count,
            }
        )
    return result


def get_flow(flow_id):
    with _session() as conn:
        row = conn.execute(
            "SELECT id, name, graph, created_at, updated_at FROM flows WHERE id = ?",
            (flow_id,),
        ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "name": row["name"],
        "graph": json.loads(row["graph"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def name_exists(name, exclude_id=None):
    with _session() as conn:
        row = conn.execute("SELECT id FROM flows WHERE name = ?", (name,)).fetchone()
    return row is not None and row["id"] != exclude_id


def save_flow(name, graph, flow_id=None, overwrite=False):
    """
    บันทึก flow: ถ้ามี flow_id ให้แก้ไขของเดิม, ถ้าไม่มีให้สร้างใหม่
    คืน (id, is_new) หรือ raise ValueError('name_exists') เมื่อชื่อชนกับของเดิม
    ถ้า overwrite=True จะเขียนทับ flow ที่ชื่อเดียวกันแทนการ raise
    """
    payload = json.dumps(graph, ensure_ascii=False)
    with _lock, _session() as conn:
        if flow_id is not None:
            row = conn.execute("SELECT id FROM flows WHERE id = ?", (flow_id,)).fetchone()
            if row is None:
                raise LookupError("ไม่พบ flow id %s" % flow_id)
            if name_exists(name, exclude_id=flow_id):
                raise ValueError("name_exists")
            conn.execute(
                "UPDATE flows SET name = ?, graph = ?, updated_at = ? WHERE id = ?",
                (name, payload, _now(), flow_id),
            )
            return flow_id, False

        if name_exists(name):
            if not overwrite:
                raise ValueError("name_exists")
            conn.execute(
                "UPDATE flows SET graph = ?, updated_at = ? WHERE name = ?",
                (payload, _now(), name),
            )
            row = conn.execute("SELECT id FROM flows WHERE name = ?", (name,)).fetchone()
            return row["id"], False

        cur = conn.execute(
            "INSERT INTO flows (name, graph, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (name, payload, _now(), _now()),
        )
        return cur.lastrowid, True


def delete_flow(flow_id):
    with _lock, _session() as conn:
        cur = conn.execute("DELETE FROM flows WHERE id = ?", (flow_id,))
        return cur.rowcount > 0
