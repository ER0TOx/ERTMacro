import asyncio
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.parse
import webbrowser


def _trace(step):
    """เขียน log ลงไฟล์ข้างตัวโปรแกรม เพื่อ debug ตอนรันเป็น .exe"""
    try:
        base = os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(base, "rme_trace.log"), "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {step}\n")
    except Exception:
        pass


_trace("1 boot")

import pyautogui
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import flowstore
import nodelib

_trace("2 imports done")

# ป้องกันเมาส์หลุดการควบคุม: เลื่อนเมาส์ไปมุมซ้ายบนสุดของจอเพื่อหยุดคำสั่งทันที
pyautogui.FAILSAFE = True

# เมื่อรันเป็น .exe (PyInstaller) ไฟล์ต่าง ๆ จะถูกแตกไปที่ sys._MEIPASS
BASE_DIR = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = FastAPI()
PORT = 8000
APP_URL = f"http://127.0.0.1:{PORT}"


class ExecutionContext:
    def __init__(self):
        self.is_running = False
        self.run_id = 0  # เพิ่มทุกครั้งที่กด Play เพื่อแยกรอบเก่า/ใหม่


runner = ExecutionContext()

# ---- Popup Windows (Alert / Confirm) ----
_popup_lock = threading.Lock()
_popup_waiters = {}
_popup_windows = {}
_popup_seq = 0
_popup_timeout = 600


def _next_popup_id():
    global _popup_seq
    with _popup_lock:
        _popup_seq += 1
        return f"popup_{_popup_seq}"


def _open_webview_popup(title, url, on_closed, popup_id=None):
    """เปิดหน้าต่าง popup แยกจากหน้าหลัก (pywebview เท่านั้น)"""
    import webview

    window = webview.create_window(
        title,
        url,
        width=460,
        height=240,
        resizable=False,
        easy_drag=False,
    )
    window.events.closed += on_closed
    if popup_id:
        with _popup_lock:
            _popup_windows[popup_id] = window
    return window


def close_popup_window(popup_id):
    """ปิดหน้าต่าง popup จากฝั่ง Python (เรียกหลัง JS ส่งคำตอบแล้ว)"""
    with _popup_lock:
        window = _popup_windows.pop(popup_id, None)
    if window is None:
        return
    try:
        window.destroy()
    except Exception as e:
        print(f"[Popup Error] ปิดหน้าต่างไม่ได้: {e}")


def open_popup(kind, message):
    """
    เปิด popup แยกจากหน้าหลัก แล้วรอผลจากผู้ใช้
    kind = 'alert' | 'confirm'
    คืนค่า 'ok' | 'confirm' | 'decline' | None (ถูกปิดหน้าต่างเอง)
    """
    popup_id = _next_popup_id()
    event = threading.Event()
    with _popup_lock:
        _popup_waiters[popup_id] = {"event": event, "value": None}

    query = urllib.parse.urlencode({"kind": kind, "id": popup_id, "message": message})
    url = f"{APP_URL}/popup.html?{query}"

    def on_closed():
        with _popup_lock:
            entry = _popup_waiters.get(popup_id)
            _popup_windows.pop(popup_id, None)
        if entry and entry["value"] is None:
            entry["value"] = "close"
            event.set()

    try:
        _open_webview_popup(
            "ALERT" if kind == "alert" else "CONFIRM", url, on_closed, popup_id
        )
    except Exception as e:
        print(f"[Popup Error] เปิดหน้าต่างไม่ได้: {e}")
        with _popup_lock:
            _popup_waiters.pop(popup_id, None)
        # สำรอง: ใช้ dialog ของ OS
        if kind == "alert":
            pyautogui.alert(message or "Alert", title="ALERT")
            return "ok"
        choice = pyautogui.confirm(
            message or "Confirm?", title="CONFIRM", buttons=["Confirm", "Decline"]
        )
        return "confirm" if choice == "Confirm" else "decline"

    event.wait(_popup_timeout)

    with _popup_lock:
        entry = _popup_waiters.pop(popup_id, None)
    # ปิดหน้าต่างทิ้งถ้าผู้ใช้ยังไม่ได้กดปุ่มเอง (เช่น timeout)
    if entry and entry["value"] is None:
        close_popup_window(popup_id)
        return None
    return entry["value"] if entry else None


@app.post("/api/popup-result")
async def popup_result(payload: dict):
    """หน้าต่าง popup ส่งคำตอบกลับมาที่นี่ แล้วสั่งปิดหน้าต่างให้อัตโนมัติ"""
    popup_id = payload.get("id")
    value = payload.get("value")
    with _popup_lock:
        entry = _popup_waiters.get(popup_id)
    if entry:
        entry["value"] = value
        entry["event"].set()
    close_popup_window(popup_id)
    return {"ok": True}


# ---- ระบบบันทึก Flow (SQLite) ----
@app.get("/api/flows")
async def api_list_flows():
    return {"ok": True, "flows": flowstore.list_flows()}


@app.get("/api/flows/{flow_id}")
async def api_get_flow(flow_id: int):
    flow = flowstore.get_flow(flow_id)
    if flow is None:
        return JSONResponse(status_code=404, content={"ok": False, "error": "not_found"})
    return {"ok": True, "flow": flow}


@app.post("/api/flows")
async def api_save_flow(payload: dict):
    name = str(payload.get("name", "")).strip()
    graph = payload.get("graph") or {}
    flow_id = payload.get("id")
    overwrite = bool(payload.get("overwrite"))

    if not name:
        return JSONResponse(status_code=400, content={"ok": False, "error": "name_required"})
    if not isinstance(graph, dict) or "nodes" not in graph:
        return JSONResponse(status_code=400, content={"ok": False, "error": "invalid_graph"})

    try:
        new_id, is_new = flowstore.save_flow(name, graph, flow_id, overwrite=overwrite)
    except ValueError:
        return JSONResponse(status_code=409, content={"ok": False, "error": "name_exists"})
    except LookupError:
        return JSONResponse(status_code=404, content={"ok": False, "error": "not_found"})

    print(f"[Save] {name} (id={new_id}) nodes={len(graph.get('nodes', []))}")
    return {"ok": True, "id": new_id, "is_new": is_new, "name": name}


@app.delete("/api/flows/{flow_id}")
async def api_delete_flow(flow_id: int):
    deleted = flowstore.delete_flow(flow_id)
    if not deleted:
        return JSONResponse(status_code=404, content={"ok": False, "error": "not_found"})
    return {"ok": True, "deleted": flow_id}


def emit(loop, ws, payload):
    """ส่งข้อความกลับหน้าเว็บแบบไม่ให้ error ลากทั้ง flow ล้ม"""
    try:
        asyncio.run_coroutine_threadsafe(ws.send_json(payload), loop)
    except Exception as e:
        print(f"[WS Error]: {e}")


def send_log(loop, ws, node_id, message):
    """ส่งข้อความไปยัง Debug node ฝั่งหน้าเว็บ"""
    emit(loop, ws, {"status": "LOG", "nodeId": node_id, "message": message})


DATA_IN_PORTS = ("img_src", "img_tgt", "pos_in")  # ขาเข้าที่รับ "ข้อมูล" (ภาพ / ตำแหน่ง) ไม่ใช่ตัวสั่งรัน
LOOP_TYPES = ("LoopFor", "LoopInf", "While")
# params ที่ไม่แทนค่า $ (ชื่อตัวแปร, คีย์ API, ไฟล์ที่แนบ)
NO_SUBST_KEYS = {"files", "apiKey", "varName", "target"}
CLICK_BUTTONS = {"LeftClick": "left", "RightClick": "right", "MiddleClick": "middle"}


def run_pipeline(graph_data, loop: asyncio.AbstractEventLoop, ws: WebSocket, run_id: int):
    def alive():
        """ยังเป็นรอบการรันปัจจุบันและยังไม่ถูกกด Pause"""
        return runner.is_running and runner.run_id == run_id

    def finish():
        # รอบเก่าที่ถูกแทนด้วยรอบใหม่ (Pause แล้ว Play ทันที) ต้องไม่ไปปิดสถานะของรอบใหม่
        if runner.run_id == run_id:
            runner.is_running = False
            emit(loop, ws, {"status": "STOPPED"})

    nodes_map = {n["id"]: n for n in graph_data.get("nodes", [])}
    out_map = {}   # from_id -> [(to_id, from_port)]  (สายสั่งรัน)
    in_map = {}    # to_id   -> [(from_id, from_port)]
    data_in = {}   # (to_id, to_port) -> (from_id, from_port)  (สายข้อมูล: ภาพ / ตำแหน่ง)
    for c in graph_data.get("connections", []):
        to_port = c.get("toPort") or "in"
        if to_port in DATA_IN_PORTS:
            data_in[(c["toNodeId"], to_port)] = (c["fromNodeId"], c.get("fromPort") or "out")
            continue
        from_port = c.get("fromPort") or "out"
        out_map.setdefault(c["fromNodeId"], []).append((c["toNodeId"], from_port))
        in_map.setdefault(c["toNodeId"], []).append((c["fromNodeId"], from_port))

    # ค้นหาโหนดเริ่มต้น (Start)
    start_node = next((n for n in graph_data.get("nodes", []) if n.get("type") == "Start"), None)
    if not start_node:
        finish()
        return

    group_lock = threading.Lock()
    claimed_groups = set()
    started_functions = set()
    outputs_data = {}   # node_id -> output ล่าสุดของโหนด
    port_outputs = {}   # (node_id, port_id) -> output เฉพาะช่อง (Feature Matching มี 2 ช่อง)
    images = {}         # node_id ของ Screenshot -> ภาพล่าสุด (เก็บแค่เฟรมเดียว ไม่สะสม)
    image_cache = {}    # (node_id, ชื่อไฟล์) -> gray ของไฟล์ภาพที่ decode แล้ว (decode ครั้งเดียวต่อรอบ)
    variables = {}      # ตัวแปร global ของรอบนี้
    var_types = {}
    var_lock = threading.Lock()
    last_error = {}
    async_lock = threading.Lock()
    async_threads = []  # สายงานของ Function โหมด Async ที่ปล่อยไปทำเบื้องหลัง

    # ---------- helpers ----------
    def report_error(node, message):
        """แจ้ง error ไปที่ console และหน้าเว็บ (กันส่งซ้ำรัว ๆ เวลาอยู่ในลูป)"""
        text = f"{node.get('name') or node.get('type')}: {message}"
        key = (node.get("id"), message)
        now = time.time()
        if now - last_error.get(key, 0) < 1.0:
            return
        last_error[key] = now
        print(f"[Engine Error] {text}")
        emit(loop, ws, {"status": "ERROR", "nodeId": node.get("id"), "message": text})

    def claim_same_name_functions(name, exclude_id):
        """คืนรายชื่อ Function ที่ชื่อเดียวกัน (ยกเว้นตัวที่กำลังรัน) และกันไม่ให้กลุ่มซ้ำ"""
        with group_lock:
            if name in claimed_groups:
                return []
            claimed_groups.add(name)
        return [
            n["id"]
            for n in nodes_map.values()
            if n.get("type") == "Function"
            and (n.get("name") or "Function") == name
            and n["id"] != exclude_id
        ]

    def claim_function_slot(node_id):
        """กันไม่ให้ Function ตัวเดียวกันถูกสั่งรันซ้ำจากหลายสาย"""
        with group_lock:
            if node_id in started_functions:
                return False
            started_functions.add(node_id)
            return True

    def reset_function_slots():
        """เริ่มรอบใหม่ของลูป: ให้ Function ในตัวลูปรันได้อีกครั้ง"""
        with group_lock:
            started_functions.clear()
            claimed_groups.clear()

    def targets_for(node_id, branch):
        """เลือกโหนดปลายทางตามช่อง output ที่เลือกได้"""
        edges = out_map.get(node_id, [])
        if branch in ("out_confirm", "out_decline"):
            # Confirm: เลือกเฉพาะสายของปุ่มที่ผู้ใช้กด (wire เก่าที่ไม่มี fromPort = ทาง Confirm)
            return [
                to for to, port in edges
                if port == branch or (port in ("out", "exec_out") and branch == "out_confirm")
            ]
        if branch in ("out_true", "out_false"):
            return [to for to, port in edges if port == branch]
        if branch in ("fm:1", "fm:0"):
            # Feature Matching: isFound ออกเสมอ, Position ออกเฉพาะตอนเจอ
            found = branch == "fm:1"
            return [
                to for to, port in edges
                if port == "out_found"
                or (found and port in ("out_position", "out_x", "out_y"))
            ]
        return [to for to, _ in edges]

    def run_targets(targets, path):
        """รันหลายสายพร้อมกัน แล้วรอทุกสายจบ"""
        targets = [t for t in targets if t not in path]
        if not targets:
            return
        if len(targets) == 1:
            run_chain(targets[0], path)
            return
        threads = [
            threading.Thread(target=run_chain, args=(t, path), daemon=True) for t in targets
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

    def get_upstream_data(node_id):
        """ดึง output ล่าสุดของโหนดที่ต่อเข้ามา (ถ้ามีหลายสายจะต่อด้วยขึ้นบรรทัดใหม่)"""
        parts = []
        for src, from_port in in_map.get(node_id, []):
            v = port_outputs.get((src, from_port))
            if v is None:
                v = outputs_data.get(src)
            if v is not None:
                parts.append(nodelib.fmt_value(v))
        if not parts:
            return None
        return parts[0] if len(parts) == 1 else "\n".join(parts)

    def resolve_params(node, upstream):
        """แทน $ตัวแปร (และ $input = ข้อมูลจาก upstream) ในทุก param ที่เป็นข้อความ"""
        extra = {"input": upstream} if upstream is not None else None
        return {
            k: v if k in NO_SUBST_KEYS else nodelib.substitute(v, variables, extra)
            for k, v in (node.get("params") or {}).items()
        }

    def get_num(node, p, key, default):
        raw = p.get(key)
        if raw is None or str(raw).strip() == "":
            return default
        n = nodelib.try_num(raw)
        if n is None:
            report_error(node, f"{key} = {raw!r} ไม่ใช่ตัวเลข (ใช้ {default} แทน)")
            return default
        return n

    def sleep_interruptible(seconds):
        """รอแบบกด Pause แล้วหยุดทันที (ไม่ต้องรอ Delay จนครบ)"""
        end = time.time() + seconds
        while alive():
            remaining = end - time.time()
            if remaining <= 0:
                break
            time.sleep(min(0.05, remaining))

    def evaluate_condition(node):
        """If / While: a, option, b  (ถ้า a ว่างและมีข้อมูลจาก upstream ใช้ข้อมูลนั้นเป็น a)"""
        upstream = get_upstream_data(node["id"])
        p = resolve_params(node, upstream)
        a = p.get("a", "")
        if str(a).strip() == "" and upstream is not None:
            a = upstream
        try:
            return nodelib.compare(a, p.get("op", "="), p.get("b", ""))
        except Exception as e:
            report_error(node, str(e))
            return False

    def get_image_gray(node, port):
        """ดึงภาพ (gray) จากโหนดที่ต่อเข้า img_src / img_tgt: File หรือ Screenshot"""
        label = "ภาพต้น" if port == "img_src" else "ภาพเป้าหมาย"
        src_id = (data_in.get((node["id"], port)) or (None, None))[0]
        src = nodes_map.get(src_id)
        if src is None:
            report_error(node, f"{label}: ยังไม่ได้ต่อสาย")
            return None

        if src.get("type") == "Screenshot":
            img = images.get(src_id)
            if img is None:
                report_error(node, f"{label}: Screenshot ยังไม่ได้ถูกสั่งรันก่อน Feature Matching")
                return None
            return nodelib.to_gray(img)

        if src.get("type") == "File":
            for f in (src.get("params") or {}).get("files") or []:
                url = f.get("dataUrl")
                if not url:
                    continue
                key = (src_id, f.get("name"), len(url))
                gray = image_cache.get(key)
                if gray is None:
                    gray = nodelib.decode_data_url_gray(url)
                    if gray is not None:
                        image_cache[key] = gray
                if gray is not None:
                    return gray
            report_error(node, f"{label}: โหนด File ไม่มีไฟล์ภาพที่อ่านได้ (รองรับภาพไม่เกิน 6 MB)")
            return None

        report_error(node, f"{label}: ต้องต่อจากโหนด File หรือ Screenshot")
        return None

    # ---------- action ฝั่ง Python ของแต่ละโหนด ----------
    def execute_node(node, ntype):
        """คืน (branch, output_data)"""
        branch = "exec_out"
        output_data = None
        nid = node["id"]
        upstream = get_upstream_data(nid)
        p = resolve_params(node, upstream)

        # ---- Program ----
        if ntype == "Delay":
            sleep_interruptible(max(0, get_num(node, p, "ms", 1000)) / 1000.0)

        elif ntype == "If":
            branch = "out_true" if evaluate_condition(node) else "out_false"

        elif ntype == "Var":
            name = nodelib.clean_var_name(p.get("varName"))
            vtype = str(p.get("vtype", "text")).lower()
            if vtype not in ("int", "float", "text", "bool"):
                vtype = "text"
            if not name:
                report_error(node, "ยังไม่ได้ตั้งชื่อตัวแปร")
            else:
                try:
                    value = nodelib.cast_value(p.get("value", ""), vtype)
                except ValueError:
                    report_error(node, f"ค่าเริ่มต้น {p.get('value')!r} แปลงเป็น {vtype} ไม่ได้ (ใช้ค่าว่างแทน)")
                    value = nodelib.cast_value("", vtype)
                with var_lock:
                    variables[name] = value
                    var_types[name] = vtype

        elif ntype == "SetVar":
            name = nodelib.clean_var_name(p.get("varName"))
            with var_lock:
                vtype = var_types.get(name)
            if not name or vtype is None:
                report_error(node, f"ยังไม่มีตัวแปร ${name} (ต้องผ่านโหนด Var ก่อน)")
            else:
                raw = p.get("value", "")
                if str(raw).strip() == "" and upstream is not None:
                    raw = upstream  # ช่องค่าว่าง = ใช้ค่าจากโหนดก่อนหน้า (X, Y, isFound ...)
                try:
                    value = nodelib.cast_value(raw, vtype)
                    with var_lock:
                        variables[name] = value
                except ValueError:
                    report_error(node, f"ค่า {raw!r} แปลงเป็น {vtype} ไม่ได้")

        elif ntype == "Math":
            try:
                result = nodelib.do_math(p.get("a", 0), p.get("op", "+"), p.get("b", 0))
            except (ValueError, ZeroDivisionError) as e:
                report_error(node, str(e))
            else:
                output_data = result
                target = nodelib.clean_var_name(p.get("target"))
                if target:
                    with var_lock:
                        vtype = var_types.get(target)
                        if vtype is None:
                            vtype = "int" if isinstance(result, int) else "float"
                            var_types[target] = vtype
                        try:
                            variables[target] = nodelib.cast_value(result, vtype)
                        except ValueError as e:
                            report_error(node, str(e))

        # ---- Action ----
        elif ntype == "Click":
            pyautogui.click(
                clicks=max(1, int(get_num(node, p, "count", 1))),
                interval=0.1,
                button=CLICK_BUTTONS.get(p.get("button"), "left"),
            )

        elif ntype == "MousePosition":
            pos_src = data_in.get((nid, "pos_in"))
            if pos_src is not None:
                # ต่อสาย Position ไว้: ใช้ตำแหน่งจาก FeatureMatching (มีเฉพาะตอนเจอภาพ)
                raw_pos = port_outputs.get(pos_src)
                nums = re.findall(r"-?\d+(?:\.\d+)?", str(raw_pos or ""))
                if len(nums) >= 2:
                    pyautogui.moveTo(int(float(nums[0])), int(float(nums[1])), duration=0.2)
                else:
                    report_error(node, "ยังไม่มีตำแหน่งจากช่อง Position (ภาพยังไม่เจอ?) - ข้ามการเลื่อนเมาส์")
            else:
                xr, yr = str(p.get("x", "")).strip(), str(p.get("y", "")).strip()
                if xr == "" and yr == "":
                    # flow เก่า: ช่อง X/Y ว่างทั้งคู่ => ใช้ "x,y" จาก upstream
                    nums = re.findall(r"-?\d+(?:\.\d+)?", str(upstream or ""))
                    if len(nums) >= 2:
                        pyautogui.moveTo(int(float(nums[0])), int(float(nums[1])), duration=0.2)
                    else:
                        report_error(node, "ไม่มีค่า X/Y และไม่มีตำแหน่งจากโหนดก่อนหน้า")
                else:
                    pyautogui.moveTo(
                        int(get_num(node, p, "x", 0)), int(get_num(node, p, "y", 0)), duration=0.2
                    )

        elif ntype == "Keyboard":
            pyautogui.write(
                str(p.get("text", "")),
                interval=max(0, get_num(node, p, "interval", 50)) / 1000.0,
            )

        elif ntype == "Agent":
            try:
                text_out = nodelib.call_agent(p)
                output_data = text_out or None
            except Exception as e:
                report_error(node, f"Agent: {e}")

        elif ntype == "URL":
            url = str(p.get("url", "")).strip()
            if not url:
                report_error(node, "ยังไม่ได้ใส่ URL")
            else:
                if "://" not in url:
                    url = "https://" + url
                if urllib.parse.urlparse(url).scheme.lower() in ("http", "https"):
                    webbrowser.open(url)
                else:
                    report_error(node, "เปิดได้เฉพาะ URL แบบ http / https")

        # ---- Message ----
        elif ntype == "Alert":
            msg = upstream if upstream is not None and str(upstream).strip() else p.get("message")
            open_popup("alert", str(msg or "") or "Alert")
            send_log(loop, ws, nid, "> Alert shown")

        elif ntype == "Confirm":
            msg = upstream if upstream is not None and str(upstream).strip() else p.get("message")
            result = open_popup("confirm", str(msg or "") or "Confirm?")
            branch = "out_confirm" if result == "confirm" else "out_decline"
            send_log(loop, ws, nid, "> " + ("Confirmed" if result == "confirm" else "Declined"))

        elif ntype == "Debug":
            sources = in_map.get(nid)
            prev = nodes_map.get(sources[0][0]) if sources else None
            send_log(loop, ws, nid, f"> {(prev or {}).get('type', 'input')}")
            if upstream is not None:
                send_log(loop, ws, nid, str(upstream))
                output_data = upstream

        elif ntype == "Text":
            # มีข้อมูลจาก upstream (เช่น Agent) ใช้ข้อมูลนั้น ไม่งั้นใช้ข้อความที่พิมพ์ในโหนด
            if upstream is not None and str(upstream).strip() != "":
                output_data = str(upstream)
            else:
                output_data = str(p.get("text", ""))

        elif ntype == "File":
            input_data = upstream
            files_list = (node.get("params") or {}).get("files") or []
            try:
                desktop = os.path.join(os.path.expanduser("~"), "Desktop")
                os.makedirs(desktop, exist_ok=True)
            except Exception:
                desktop = os.getcwd()

            created_files = []

            # ถ้ามี input_data จาก Text (หรือ upstream) => สร้างไฟล์ 1 ไฟล์ตาม input_data
            if input_data is not None and str(input_data):
                raw = str(input_data)
                fname_src = raw.rstrip('\r\n')
                fname_clean = re.sub(r'[\\/:*?"<>|]+', '_', fname_src).strip()
                if not fname_clean:
                    fname_clean = 'file'
                base, ext = os.path.splitext(fname_clean)
                if ext == '':
                    ext = '.txt'
                fname_final = base + ext
                fpath = os.path.join(desktop, fname_final)
                try:
                    with open(fpath, 'w', encoding='utf-8', errors='replace') as f:
                        f.write(raw)
                    created_files.append({"name": os.path.basename(fpath), "path": fpath})
                    send_log(loop, ws, nid, f'> Created {os.path.basename(fpath)}')
                except Exception as e:
                    send_log(loop, ws, nid, f'> File error: {e}')

            # ถ้าไม่มี input_data แต่มีไฟล์ที่อัปโหลดไว้ => เขียนตามไฟล์นั้น (เดิม)
            elif files_list:
                for f in files_list:
                    try:
                        fname_c = f.get("name") or "file"
                        fpath_c = os.path.join(desktop, fname_c)
                        content_c = f.get("content")
                        dataurl = f.get("dataUrl")
                        if content_c is not None:
                            with open(fpath_c, "w", encoding="utf-8", errors="replace") as fw:
                                fw.write(str(content_c))
                        elif dataurl:
                            try:
                                import base64

                                if "," in dataurl:
                                    b64 = dataurl.split(",", 1)[1]
                                else:
                                    b64 = dataurl
                                raw = base64.b64decode(b64)
                                with open(fpath_c, "wb") as fb:
                                    fb.write(raw)
                            except Exception:
                                pass
                        created_files.append({"name": os.path.basename(fpath_c), "path": fpath_c})
                        send_log(loop, ws, nid, f"> Wrote {os.path.basename(fpath_c)}")
                    except Exception as e:
                        send_log(loop, ws, nid, f"> File error: {e}")

            else:
                send_log(loop, ws, nid, "> no file input")

            output_data = created_files if created_files else None

        # ---- Image processing ----
        elif ntype == "Screenshot":
            try:
                img = nodelib.grab_screen()
            except ImportError:
                report_error(node, "ต้องติดตั้ง: pip install mss numpy")
            else:
                images[nid] = img
                output_data = nodelib.ImageRef(img)

        elif ntype == "FeatureMatching":
            threshold = min(1.0, max(0.0, float(get_num(node, p, "threshold", 0.8))))
            found, position = False, None
            try:
                source = get_image_gray(node, "img_src")
                target = get_image_gray(node, "img_tgt")
                if source is not None and target is not None:
                    found, position, _score = nodelib.match_template(source, target, threshold)
            except ImportError:
                report_error(node, "ต้องติดตั้ง: pip install opencv-python numpy")
            port_outputs[(nid, "out_found")] = bool(found)  # ชนิด boolean จริง
            if found:
                port_outputs[(nid, "out_position")] = f"{position[0]},{position[1]}"
                port_outputs[(nid, "out_x")] = position[0]
                port_outputs[(nid, "out_y")] = position[1]
            else:
                for k in ("out_position", "out_x", "out_y"):
                    port_outputs.pop((nid, k), None)
            branch = "fm:1" if found else "fm:0"

        return branch, output_data

    def is_async_function(node):
        mode = str((node.get("params") or {}).get("mode", "Sync")).strip().lower()
        return mode == "async"

    def spawn_async(targets, path):
        targets = [t for t in targets if t not in path]
        if not targets:
            return
        th = threading.Thread(target=run_targets, args=(targets, path), daemon=True)
        with async_lock:
            async_threads.append(th)
        th.start()

    def run_loop(node, path):
        """LoopFor / LoopInf / While: ช่อง Loop = เนื้อในลูป, ช่อง Done = ทำต่อหลังลูปจบ"""
        nid, ntype = node["id"], node["type"]
        next_path = path | {nid}
        edges = out_map.get(nid, [])
        body = [to for to, port in edges if port == "out_loop"]
        done = [to for to, port in edges if port == "out_done"]

        total = None
        if ntype == "LoopFor":
            p = resolve_params(node, get_upstream_data(nid))
            total = max(0, int(get_num(node, p, "count", 1)))

        i = 0
        while alive():
            if total is not None and i >= total:
                break
            if ntype == "While" and not evaluate_condition(node):
                break
            i += 1
            reset_function_slots()
            if body:
                run_targets(body, next_path)
                time.sleep(0)  # ปล่อย CPU ให้ thread อื่น (ลูปเร็ว ๆ เช่น screenshot)
            elif ntype != "LoopFor":
                time.sleep(0.05)  # ไม่มีอะไรในลูป: กันกิน CPU เต็มที่

        if alive():
            run_targets(done, next_path)

    def run_chain(node_id, path):
        if not alive() or node_id in path:
            return

        node = nodes_map.get(node_id)
        if node is None or node.get("type") == "End":
            return

        ntype = node.get("type")

        # Function ที่ชื่อเดียวกัน: แต่ละตัวรันครั้งเดียว แม้จะมีหลายสายสั่งเข้ามา
        if ntype == "Function" and not claim_function_slot(node_id):
            return

        if ntype in LOOP_TYPES:
            run_loop(node, path)
            return

        try:
            branch, outd = execute_node(node, ntype)
            if outd is not None:
                outputs_data[node_id] = outd
            else:
                outputs_data.pop(node_id, None)  # ไม่ให้ค่าเก่าค้างข้ามรอบลูป
        except Exception as e:
            report_error(node, str(e) or type(e).__name__)
            return

        if not alive():
            return

        next_path = path | {node_id}
        next_targets = targets_for(node_id, branch)

        # Function: รันทุกโหนด Function ที่มีชื่อเดียวกันพร้อมกัน
        if ntype == "Function":
            group_name = node.get("name") or "Function"
            next_targets += claim_same_name_functions(group_name, node_id)

        # Function โหมด Async: ปล่อยสายงานต่อจากตัวมันไปทำเบื้องหลังแล้วกลับไปทำงานอื่นต่อทันที
        # โหมด Sync (ค่าเริ่มต้น): รอให้สายงานต่อจากตัวมันจบก่อนค่อยไปต่อ
        if ntype == "Function" and is_async_function(node):
            spawn_async(next_targets, next_path)
            return

        run_targets(next_targets, next_path)

    def wait_async_done():
        """รอสายงาน Async ทั้งหมดจบ (หรือถูกกด Pause) ก่อนปิดรอบการรัน"""
        while True:
            with async_lock:
                pending = [t for t in async_threads if t.is_alive()]
            if not pending:
                return
            for t in pending:
                t.join(0.1)

    try:
        run_chain(start_node["id"], frozenset())
        wait_async_done()
    except Exception as e:
        print(f"[Engine Error]: {e}")
    finally:
        finish()


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    loop = asyncio.get_running_loop()

    try:
        while True:
            raw_text = await ws.receive_text()
            data = json.loads(raw_text)
            action = data.get("action")

            if action == "START":
                if not runner.is_running:
                    runner.run_id += 1
                    runner.is_running = True
                    graph = data.get("graph", {})
                    threading.Thread(
                        target=run_pipeline,
                        args=(graph, loop, ws, runner.run_id),
                        daemon=True,
                    ).start()
                    await ws.send_json({"status": "RUNNING"})

            elif action == "STOP":
                runner.is_running = False
                await ws.send_json({"status": "STOPPED"})

    except WebSocketDisconnect:
        runner.is_running = False


# เสิร์ฟไฟล์ Frontend จากโฟลเดอร์ static
if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


def pick_port(preferred=8000):
    """เลือก port ว่าง เพื่อไม่ให้ชนกับโปรแกรมอื่น (สำคัญมากตอนเป็น .exe)"""
    for candidate in [preferred] + list(range(preferred + 1, preferred + 30)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", candidate))
                return candidate
            except OSError:
                continue
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_server(timeout=15.0):
    """รอจนกว่า server จะตอบกลับ ก่อนเปิดหน้าต่าง"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.15)
    return False


def start_server():
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    _trace("3 main entered")
    PORT = pick_port()
    APP_URL = f"http://127.0.0.1:{PORT}"
    print(f"Retro Macro Engine -> {APP_URL}")
    _trace(f"4 port {PORT}")

    # เริ่มรัน Backend Server แยก Thread
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()
    ready = wait_for_server()
    _trace(f"5 server ready={ready}")

    # ลองรันเป็น Native Desktop Window ด้วย pywebview
    try:
        import webview

        _trace("6 webview imported")
        webview.create_window(
            title="Retro Macro Engine",
            url=APP_URL,
            width=1280,
            height=800,
            resizable=True,
        )
        _trace("7 window created")
        webview.start()
        _trace("8 webview closed")
    except ImportError:
        # หากยังไม่ได้ลง pywebview จะเปิดผ่าน Browser ปกติ
        import webbrowser

        time.sleep(0.8)
        webbrowser.open(APP_URL)
        server_thread.join()
    _trace("9 exit")