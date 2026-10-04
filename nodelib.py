"""ฟังก์ชันช่วยของโหนดใน Retro Macro Engine
(ตัวแปร $name, เงื่อนไข, คณิตศาสตร์, เรียก Agent, screenshot และ template matching)
แยกจาก server.py เพื่อให้ทดสอบเดี่ยว ๆ ได้ และ import ไลบรารีหนัก (cv2/mss) แบบ lazy
"""
import base64
import json
import re
import threading
import urllib.error
import urllib.request

# ---------------------------------------------------------------------------
# ตัวแปร: $name หรือ ${name}  (ถ้าไม่มีตัวแปรนี้ ให้คงข้อความ $name ไว้ตามเดิม)
# ---------------------------------------------------------------------------
_NAME_CHARS = r"A-Za-z0-9_\u0E00-\u0E7F"
VAR_RE = re.compile(r"\$\{([^}]+)\}|\$([" + _NAME_CHARS + r"]+)")


def fmt_value(v):
    """แปลงค่าตัวแปรเป็นข้อความ (float ที่เป็นจำนวนเต็มแสดง 3.0 ตามชนิดจริง)"""
    if isinstance(v, bool):
        return "true" if v else "false"  # boolean แสดงเป็นตัวพิมพ์เล็กเสมอ
    return str(v)


def substitute(value, variables, extra=None):
    """แทน $name ด้วยค่าตัวแปร; extra ใช้สำหรับชื่อพิเศษ เช่น $input (มาก่อนตัวแปรผู้ใช้)"""
    if not isinstance(value, str) or "$" not in value:
        return value

    def repl(m):
        name = (m.group(1) or m.group(2) or "").strip()
        if extra and name in extra:
            return fmt_value(extra[name])
        if name in variables:
            return fmt_value(variables[name])
        return m.group(0)

    return VAR_RE.sub(repl, value)


def clean_var_name(raw):
    """ชื่อตัวแปรที่ผู้ใช้พิมพ์: รับทั้ง myvar และ $myvar"""
    name = str(raw or "").strip()
    if name.startswith("${") and name.endswith("}"):
        name = name[2:-1]
    elif name.startswith("$"):
        name = name[1:]
    return name.strip()


def cast_value(raw, vtype):
    """แปลงข้อความเป็น int/float/text ตาม type ของตัวแปร (ผิดรูปแบบ -> ValueError)"""
    vtype = (vtype or "text").lower()
    if vtype == "bool":
        if isinstance(raw, bool):
            return raw
        s = str(raw).strip().lower()
        if s in ("true", "1", "yes", "y", "on", "t"):
            return True
        if s in ("false", "0", "no", "n", "off", "f", ""):
            return False
        raise ValueError("ค่า %r ไม่ใช่ boolean (ใช้ true / false)" % (raw,))
    if vtype == "int":
        s = str(raw).strip()
        return int(float(s)) if s != "" else 0
    if vtype == "float":
        s = str(raw).strip()
        return float(s) if s != "" else 0.0
    return "" if raw is None else str(raw)


def try_num(x):
    """คืนตัวเลข (int/float) หรือ None ถ้าแปลงไม่ได้"""
    try:
        f = float(str(x).strip())
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return int(f) if f.is_integer() and "." not in str(x) and "e" not in str(x).lower() else f


# ---------------------------------------------------------------------------
# เงื่อนไข (If / While) และ Math
# ---------------------------------------------------------------------------
COMPARE_OPS = ("=", "~", "<", ">", "<=", ">=")
_NE_ALIASES = ("~", "!=", "≠", "<>")


def compare(a, op, b):
    """
    เปรียบเทียบ a กับ b  (= เท่ากับ, ~ ไม่เท่ากับ, < > <= >=)
    ถ้าทั้งคู่เป็นตัวเลขจะเทียบเป็นตัวเลข ไม่งั้นเทียบเป็นข้อความ
    """
    op = str(op).strip()
    if op == "==":
        op = "="
    # B ว่าง และ A เป็น boolean (true/false) => ตรวจว่า A เป็นจริงหรือไม่
    if str(b).strip() == "" and str(a).strip().lower() in ("true", "false"):
        b = "true"
    na, nb = try_num(a), try_num(b)
    if na is not None and nb is not None:
        x, y = na, nb
    else:
        x, y = str(a).strip(), str(b).strip()
        if x.lower() in ("true", "false") or y.lower() in ("true", "false"):
            x, y = x.lower(), y.lower()

    if op == "=":
        return x == y
    if op in _NE_ALIASES:
        return x != y
    if op == "<":
        return x < y
    if op == ">":
        return x > y
    if op == "<=":
        return x <= y
    if op == ">=":
        return x >= y
    raise ValueError("ตัวเลือกเงื่อนไขไม่ถูกต้อง: %r" % op)


def do_math(a, op, b):
    """+ - * /  คืน int ถ้าผลเป็นจำนวนเต็มจากการ + - * ของ int, นอกนั้นเป็น float"""
    x, y = try_num(a), try_num(b)
    if x is None:
        raise ValueError("A ไม่ใช่ตัวเลข: %r" % (a,))
    if y is None:
        raise ValueError("B ไม่ใช่ตัวเลข: %r" % (b,))
    op = str(op).strip()
    if op == "+":
        r = x + y
    elif op == "-":
        r = x - y
    elif op == "*":
        r = x * y
    elif op == "/":
        if y == 0:
            raise ZeroDivisionError("หารด้วยศูนย์")
        r = x / y
    else:
        raise ValueError("ตัวดำเนินการต้องเป็น + - * / เท่านั้น")
    return r


# ---------------------------------------------------------------------------
# Agent (Local / Cloud)
# ---------------------------------------------------------------------------
def _post_json(url, headers, body, timeout=120):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=dict({"Content-Type": "application/json"}, **headers),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError("HTTP %s: %s" % (e.code, detail))
    except urllib.error.URLError as e:
        raise RuntimeError("เชื่อมต่อไม่ได้: %s" % e.reason)


def _normalize_local_url(url):
    url = url.strip()
    if "chat/completions" in url:
        return url
    if url.rstrip("/").endswith("/v1"):
        return url.rstrip("/") + "/chat/completions"
    return url


DEFAULT_MODELS = {
    "gemini": "gemini-2.5-flash",
    "gpt": "gpt-4o-mini",
    "claude": "claude-haiku-4-5-20251001",
}


def call_agent(params):
    """
    เรียก LLM ตาม params ของโหนด Agent แล้วคืนข้อความตอบกลับ
    mode: 'Local Agent' -> endpoint แบบ OpenAI-compatible (Ollama, LM Studio, llama.cpp ...)
          'Cloud Agent' -> provider: Gemini | GPT | Claude
    """
    mode = str(params.get("mode", "Cloud Agent")).lower()
    prompt = str(params.get("prompt", "")).strip()
    model = str(params.get("model", "")).strip()
    if not prompt:
        raise ValueError("ยังไม่ได้ใส่ prompt")

    if "local" in mode:
        url = _normalize_local_url(str(params.get("apiUrl", "")))
        if not url:
            raise ValueError("ยังไม่ได้ใส่ API URL ของ Local Agent")
        body = {"messages": [{"role": "user", "content": prompt}]}
        if model:
            body["model"] = model
        headers = {}
        key = str(params.get("apiKey", "")).strip()
        if key:
            headers["Authorization"] = "Bearer " + key
        data = _post_json(url, headers, body)
        return data["choices"][0]["message"]["content"].strip()

    provider = str(params.get("provider", "Gemini")).strip().lower()
    key = str(params.get("apiKey", "")).strip()
    if not key:
        raise ValueError("ยังไม่ได้ใส่ API key")

    if provider == "gemini":
        from google import genai

        client = genai.Client(api_key=key)
        res = client.models.generate_content(
            model=model or DEFAULT_MODELS["gemini"], contents=prompt
        )
        return (res.text or "").strip()

    if provider == "gpt":
        data = _post_json(
            "https://api.openai.com/v1/chat/completions",
            {"Authorization": "Bearer " + key},
            {
                "model": model or DEFAULT_MODELS["gpt"],
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        return data["choices"][0]["message"]["content"].strip()

    if provider == "claude":
        data = _post_json(
            "https://api.anthropic.com/v1/messages",
            {"x-api-key": key, "anthropic-version": "2023-06-01"},
            {
                "model": model or DEFAULT_MODELS["claude"],
                "max_tokens": 2048,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        return "".join(
            b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
        ).strip()

    raise ValueError("ไม่รู้จัก provider: %s" % provider)


# ---------------------------------------------------------------------------
# Screenshot (เร็วพอสำหรับลูปแบบวิดีโอ) + Template matching
# ---------------------------------------------------------------------------
class ImageRef:
    """ตัวแทนรูปที่ส่งผ่านสาย (ไม่เก็บ pixel จริงใน output_data เพื่อไม่ให้ str() ใหญ่)"""

    def __init__(self, array):
        self.array = array
        self.height, self.width = array.shape[:2]

    def __str__(self):
        return "<image %dx%d>" % (self.width, self.height)


class _Grabber:
    """mss 1 ตัวต่อ 1 thread (mss ผูก handle กับ thread) และปิดให้เองเมื่อ thread จบ"""

    def __init__(self):
        import mss

        self.sct = mss.mss()
        self.monitor = self.sct.monitors[1]  # จอหลัก

    def __del__(self):
        try:
            self.sct.close()
        except Exception:
            pass


_tls = threading.local()


def grab_screen():
    """
    จับภาพหน้าจอหลักเป็น numpy BGRA (h, w, 4)
    - ใช้ mss (เร็วกว่า pyautogui/PIL มาก) และ reuse instance ต่อ thread
    - ไม่ encode PNG/base64 ใช้ buffer ดิบของ mss โดยตรง (zero-copy)
    """
    import numpy as np

    grabber = getattr(_tls, "grabber", None)
    if grabber is None:
        grabber = _tls.grabber = _Grabber()
    shot = grabber.sct.grab(grabber.monitor)
    return np.frombuffer(shot.raw, dtype=np.uint8).reshape(shot.height, shot.width, 4)


def to_gray(img):
    """แปลงภาพ (BGRA/BGR/gray) เป็น gray 8 บิต"""
    import cv2

    if img.ndim == 2:
        return img
    if img.shape[2] == 4:
        return cv2.cvtColor(img, cv2.COLOR_BGRA2GRAY)
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def decode_data_url_gray(data_url):
    """data URL (base64) ของไฟล์ภาพ -> gray numpy; ถอดรหัสไม่ได้ -> None"""
    import cv2
    import numpy as np

    b64 = data_url.split(",", 1)[1] if "," in data_url else data_url
    raw = np.frombuffer(base64.b64decode(b64), dtype=np.uint8)
    return cv2.imdecode(raw, cv2.IMREAD_GRAYSCALE)


def match_template(source_gray, target_gray, threshold):
    """
    หา target ใน source ด้วย TM_CCOEFF_NORMED
    คืน (found, (cx, cy) | None, score)  cx,cy = จุดกึ่งกลางของ target ในภาพต้น
    """
    import cv2

    sh, sw = source_gray.shape[:2]
    th, tw = target_gray.shape[:2]
    if th > sh or tw > sw:
        return False, None, 0.0

    result = cv2.matchTemplate(source_gray, target_gray, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(result)
    if max_val != max_val:  # NaN (เช่น template สีเดียวทั้งภาพ)
        return False, None, 0.0
    if max_val >= threshold:
        return True, (max_loc[0] + tw // 2, max_loc[1] + th // 2), float(max_val)
    return False, None, float(max_val)