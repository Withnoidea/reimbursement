import json
import re
import sys
from pathlib import Path

# 识别引擎统一用 RapidOCR（onnxruntime，纯 CPU）。
# PDF 由 pypdfium2 负责抽文字层和渲染位图，不使用 PyMuPDF：
#   1. PyMuPDF 是 AGPL 协议，随应用分发有合规风险；
#   2. pypdfium2 是 py3-none-win_amd64 的 wheel，不绑 CPython ABI，零依赖，
#      装进内嵌运行时（tools/runtime）更稳。
# 注意：pypdfium2 和 rapidocr 都在函数内部懒加载。
# scripts/parse-regression.py 会直接 import 下面几个纯文本函数做回归，
# 模块级拖起 onnxruntime 会让回归脚本又慢又脆。

SMALL_AMOUNT_PATTERNS = [
    re.compile(r"[（(]\s*小写\s*[）)]\s*[¥￥]?\s*([0-9]+(?:\.[0-9]{1,2})?)"),
    re.compile(r"小写\s*[¥￥]?\s*([0-9]+(?:\.[0-9]{1,2})?)"),
]
CURRENCY_PATTERN = re.compile(r"[¥￥]\s*([0-9]+(?:\.[0-9]{1,2})?)")
# 行程单、账单等无 ¥ 符号的单据：带标签的合计金额
LABELED_AMOUNT_PATTERNS = [
    re.compile(r"(?:价税合计|合计金额|金额合计|总计|应付金额|实付金额|实收金额|付款金额)[:：]?[¥￥]?([0-9]{1,7}(?:\.[0-9]{1,2})?)"),
    re.compile(r"合计[:：]?[¥￥]?([0-9]{1,7}(?:\.[0-9]{1,2})?)元"),
]
# 前后紧邻数字或点号的不算（排除 2026.07.09 这类日期片段）
DECIMAL_AMOUNT_PATTERN = re.compile(r"(?<![0-9.])([0-9]{1,6}\.[0-9]{2})(?![0-9.])")
INVOICE_NO_PATTERN = re.compile(r"发票号码\s*[:：]?\s*([0-9]{8,})")
ANY_INVOICE_NO_PATTERN = re.compile(r"\b(\d{20})\b")
DATE_PATTERN = re.compile(r"开票日期\s*[:：]?\s*(\d{4}年\d{1,2}月\d{1,2}日)")
ANY_DATE_PATTERN = re.compile(r"\d{4}年\d{1,2}月\d{1,2}日")
ANY_NUMERIC_DATE_PATTERN = re.compile(r"(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})")
DATE_PARTS_PATTERN = re.compile(r"(\d{4})\D+(\d{1,2})\D+(\d{1,2})")
DATE_NUMBERS_PATTERN = re.compile(r"(20\d{2})\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})")

PDF_MAGIC = b"%PDF-"
JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

OCR_ZOOM = 3.0  # 渲染倍率，约 216dpi，发票小字够用
OCR_MAX_PAGES = 3  # 长文档只 OCR 前几页，避免卡住批量导入
MIN_TEXT_CHARS_PER_PAGE = 20  # 低于这个字符数就当作没有文字层
IMAGE_MAX_SIDE = 2400  # 手机拍的发票动辄 4000px 以上，先缩小再识别
A4_HEIGHT_PT = 842.0

_ocr_engine = None


def detect_kind(pdf_path: Path):
    with open(pdf_path, "rb") as handle:
        head = handle.read(8)
    if head.startswith(PDF_MAGIC):
        return "pdf"
    if head.startswith(JPEG_MAGIC) or head.startswith(PNG_MAGIC):
        return "image"
    return "image" if pdf_path.suffix.lower() in {".png", ".jpg", ".jpeg"} else "pdf"


def extract_text(pdf_path: Path):
    """抽取 PDF 文字层。返回 (整页文本, 页数)。扫描件会得到空字符串。"""
    import pypdfium2 as pdfium

    chunks = []
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        page_count = len(pdf)
        for page in pdf:
            textpage = page.get_textpage()
            chunks.append(textpage.get_text_bounded() or "")
        return "\n".join(chunks), page_count
    finally:
        pdf.close()


def get_ocr_engine():
    global _ocr_engine
    if _ocr_engine is None:
        from rapidocr import RapidOCR

        _ocr_engine = RapidOCR()
    return _ocr_engine


def ocr_array(image, page_index=0, scale=1.0):
    """对单张图片做 OCR，返回 (文本行列表, words)。scale 用于把像素坐标折回版面坐标。"""
    result = get_ocr_engine()(image)
    boxes = getattr(result, "boxes", None)
    texts = getattr(result, "txts", None)
    if boxes is None or texts is None:
        return [], []

    words = []
    for box, text in zip(boxes, texts):
        value = str(text or "").strip()
        if not value:
            continue
        xs = [float(point[0]) for point in box]
        ys = [float(point[1]) for point in box]
        words.append(
            {
                "page": page_index,
                "x0": min(xs) / scale,
                "y0": min(ys) / scale,
                "x1": max(xs) / scale,
                "text": value,
            }
        )
    return [word["text"] for word in words], words


def ocr_pdf(pdf_path: Path):
    """渲染 PDF 页面后 OCR。返回 (文本, words)。"""
    import numpy as np
    import pypdfium2 as pdfium

    all_words = []
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        for page_index, page in enumerate(pdf):
            if page_index >= OCR_MAX_PAGES:
                break
            bitmap = page.render(scale=OCR_ZOOM)
            array = bitmap.to_numpy()
            if array.ndim == 3 and array.shape[2] == 4:
                array = array[:, :, :3]
            # 除以渲染倍率，坐标折回 PDF 点，这样 build_lines 的行间距阈值继续有效
            _, words = ocr_array(np.ascontiguousarray(array), page_index, OCR_ZOOM)
            all_words.extend(words)
    finally:
        pdf.close()

    return words_to_text(all_words), all_words


def ocr_image(pdf_path: Path):
    """OCR 单张图片发票。返回 (文本, words)。"""
    import cv2
    import numpy as np

    # cv2.imread 在中文路径下会失败，用 fromfile + imdecode 兜底
    buffer = np.fromfile(str(pdf_path), dtype=np.uint8)
    image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("无法读取图片")

    height, width = image.shape[:2]
    longest = max(height, width)
    if longest > IMAGE_MAX_SIDE:
        ratio = IMAGE_MAX_SIDE / longest
        image = cv2.resize(image, (int(width * ratio), int(height * ratio)), interpolation=cv2.INTER_AREA)
        longest = IMAGE_MAX_SIDE

    # 把像素坐标折算到近似 A4 点空间，让 build_lines 的行间距阈值保持同一量纲
    _, words = ocr_array(image, 0, max(longest / A4_HEIGHT_PT, 1e-6))
    return words_to_text(words), words


def words_to_text(words):
    return "\n".join(line["text"] for line in build_lines(words))


def extract_amount(text: str):
    normalized = re.sub(r"\s+", "", text)
    for pattern in SMALL_AMOUNT_PATTERNS:
        match = pattern.search(normalized)
        if match:
            return round(float(match.group(1)), 2)

    values = [float(value) for value in CURRENCY_PATTERN.findall(text)]
    if values:
        return round(max(values), 2)

    for pattern in LABELED_AMOUNT_PATTERNS:
        match = pattern.search(normalized)
        if match:
            return round(float(match.group(1)), 2)

    decimal_values = [
        float(value)
        for value in DECIMAL_AMOUNT_PATTERN.findall(text)
        if not looks_like_year_month(value)
    ]
    if decimal_values:
        return round(max(decimal_values), 2)

    return None


def looks_like_year_month(value: str):
    whole, _, fraction = value.partition(".")
    return len(fraction) == 2 and fraction.isdigit() and 1 <= int(fraction) <= 12 and 1900 <= int(whole) <= 2099


def extract_invoice_no(text: str, lines=None):
    normalized = re.sub(r"\s+", "", text)
    direct = INVOICE_NO_PATTERN.search(normalized)
    if direct:
        return direct.group(1)
    positioned = field_value_from_lines(lines or [], "发票号码")
    if positioned:
        match = re.search(r"\d{8,20}", positioned)
        if match:
            return match.group(0)
    fallback = ANY_INVOICE_NO_PATTERN.search(text)
    return fallback.group(1) if fallback else ""


def extract_invoice_date(text: str, lines=None):
    normalized = re.sub(r"\s+", "", text)
    direct = DATE_PATTERN.search(normalized)
    if direct:
        return normalize_date(direct.group(1))
    positioned = field_value_from_lines(lines or [], "开票日期")
    if positioned:
        date = normalize_date(positioned)
        if date:
            return date
    fallback = ANY_DATE_PATTERN.search(text)
    if fallback:
        return normalize_date(fallback.group(0))
    numeric = ANY_NUMERIC_DATE_PATTERN.search(normalized)
    if numeric:
        year, month, day = numeric.groups()
        return f"{year}-{int(month):02d}-{int(day):02d}"
    return ""


def normalize_date(value: str):
    match = DATE_PARTS_PATTERN.search(value)
    if not match:
        match = DATE_NUMBERS_PATTERN.search(value)
    if not match:
        return ""
    year, month, day = match.groups()
    return f"{year}-{int(month):02d}-{int(day):02d}"


def build_lines(words):
    lines = []
    for word in sorted(words, key=lambda item: (item["page"], item["y0"], item["x0"])):
        current = lines[-1] if lines else None
        if current and current["page"] == word["page"] and abs(current["y"] - word["y0"]) <= 3:
            current["words"].append(word)
            current["y"] = (current["y"] + word["y0"]) / 2
        else:
            lines.append({"page": word["page"], "y": word["y0"], "words": [word]})

    for line in lines:
        line["words"].sort(key=lambda item: item["x0"])
        line["text"] = "".join(word["text"] for word in line["words"])
    return lines


def field_value_from_lines(lines, label):
    for line in lines:
        label_end = None
        for word in line["words"]:
            if label in word["text"]:
                label_end = word["x1"]
                break
        if label_end is None:
            continue

        values = [
            word["text"].strip()
            for word in line["words"]
            if word["x0"] >= label_end - 1 and word["text"].strip()
        ]
        if values:
            return "".join(values)
    return ""


def parse_document(pdf_path: Path):
    kind = detect_kind(pdf_path)

    if kind == "image":
        text, words = ocr_image(pdf_path)
        lines = build_lines(words)
        return {
            "amount": extract_amount(text),
            "invoiceNo": extract_invoice_no(text, lines),
            "invoiceDate": extract_invoice_date(text, lines),
            "pageCount": 1,
            "engine": "ocr",
        }

    text, page_count = extract_text(pdf_path)
    result = {
        "amount": extract_amount(text),
        "invoiceNo": extract_invoice_no(text),
        "invoiceDate": extract_invoice_date(text),
        "pageCount": page_count,
        "engine": "text",
    }

    has_text_layer = len(text.strip()) >= MIN_TEXT_CHARS_PER_PAGE * max(page_count, 1)
    missing = result["amount"] is None or not result["invoiceNo"] or not result["invoiceDate"]
    if has_text_layer and not missing:
        return result

    # 扫描件没有文字层，电子发票偶尔也会缺字段，两种情况都用 OCR 补。
    # OCR 出问题绝不能连累已经拿到的文字层结果，所以整段包起来。
    try:
        ocr_text, ocr_words = ocr_pdf(pdf_path)
        ocr_lines = build_lines(ocr_words)
        filled = False
        if result["amount"] is None:
            result["amount"] = extract_amount(ocr_text)
            filled = filled or result["amount"] is not None
        if not result["invoiceNo"]:
            result["invoiceNo"] = extract_invoice_no(ocr_text, ocr_lines)
            filled = filled or bool(result["invoiceNo"])
        if not result["invoiceDate"]:
            result["invoiceDate"] = extract_invoice_date(ocr_text, ocr_lines)
            filled = filled or bool(result["invoiceDate"])
        if filled:
            result["engine"] = "text+ocr" if has_text_layer else "ocr"
    except Exception as error:  # noqa: BLE001 - OCR 失败时保留文字层结果
        print(f"OCR fallback failed: {error}", file=sys.stderr)

    return result


def main():
    pdf_path = Path(sys.argv[1])
    print(json.dumps(parse_document(pdf_path)))


if __name__ == "__main__":
    main()
