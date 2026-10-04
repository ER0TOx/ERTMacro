# UTF-8
#
# PyInstaller spec สำหรับ Retro Macro Engine (Desktop app / .exe ไฟล์เดียว)
# สร้างด้วย:  python -m PyInstaller --noconfirm --clean RetroMacro.spec
#
import os

block_cipher = None

ROOT = os.path.abspath(os.getcwd())
ICON = os.path.join(ROOT, "assets", "app.ico")
VERSION = os.path.join(ROOT, "assets", "version_info.txt")

a = Analysis(
    ["server.py"],
    pathex=[ROOT],
    binaries=[],
    # โฟลเดอร์ static ทั้งก้อน (index.html, popup.html, script.js, style.css, เสียง) ต้องถูกฝังไปกับ .exe
    datas=[(os.path.join(ROOT, "static"), "static")],
    hiddenimports=[
        # pywebview บน Windows ใช้ WinForms + WebView2 ผ่าน pythonnet
        "webview.platforms.winforms",
        "webview.platforms.edgechromium",
        "clr",
        "pythonnet",
        # uvicorn เลือก loop/protocol ตอนรัน
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.loops.asyncio",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.protocols.websockets.websockets_impl",
        "uvicorn.lifespan.on",
        "uvicorn.lifespan.off",
        "websockets",
        "anyio",
        # tkinter ใช้เป็นตัวสำรองตอนเปิด Alert/Confirm (pyautogui.alert/confirm)
        "tkinter",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "matplotlib",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "PyQtWebEngine",
        "IPython",
        "jupyter",
        "notebook",
        "pytest",
        "sphinx",
        "setuptools._distutils",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="RetroMacroEngine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=os.environ.get("RME_CONSOLE") == "1",  # RME_CONSOLE=1 ตอน debug เพื่อดู traceback
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=ICON if os.path.exists(ICON) else None,
    version=VERSION if os.path.exists(VERSION) else None,
)
