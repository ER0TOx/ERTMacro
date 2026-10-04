"""สร้างไอคอนแอป (assets/app.ico) สำหรับ PyInstaller"""
import os

from PIL import Image, ImageDraw, ImageFont

SIZE = 256
BG = (28, 47, 47)
FRAME_HI = (255, 255, 255)
FRAME_LO = (0, 0, 0)
TITLEBAR = (16, 132, 208)
TEXT = (51, 255, 102)

img = Image.new("RGBA", (SIZE, SIZE), BG + (255,))
d = ImageDraw.Draw(img)

# ขอบแบบ Win95 bevel
d.rectangle([4, 4, SIZE - 5, SIZE - 5], outline=FRAME_HI + (255,), width=4)
d.rectangle([8, 8, SIZE - 9, SIZE - 9], outline=(128, 128, 128, 255), width=3)
d.rectangle([12, 12, SIZE - 13, SIZE - 13], outline=FRAME_LO + (255,), width=2)

# แถบหัวเรื่อง
d.rectangle([16, 16, SIZE - 17, 52], fill=TITLEBAR + (255,))

# ช่องคอนโซลเขียว
d.rectangle([26, 66, SIZE - 27, SIZE - 27], fill=(11, 26, 11, 255), outline=FRAME_HI + (255,), width=3)

font_path = r"C:\Windows\Fonts\consolab.ttf"
try:
    font = ImageFont.truetype(font_path, 92)
except OSError:
    font = ImageFont.load_default()

lines = [">_", "R M"]
y = 78
for line in lines:
    bbox = d.textbbox((0, 0), line, font=font)
    d.text(((SIZE - (bbox[2] - bbox[0])) / 2, y), line, font=font, fill=TEXT + (255,))
    y += 84

os.makedirs("assets", exist_ok=True)
img.save("assets/app.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
img.save("assets/app.png")
print("created assets/app.ico + assets/app.png")
