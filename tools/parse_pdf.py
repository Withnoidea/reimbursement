import json
import re
import sys
from pathlib import Path

import fitz


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


def extract_text(pdf_path: Path):
    chunks = []
    words = []
    with fitz.open(pdf_path) as doc:
        for page_index, page in enumerate(doc):
            chunks.append(page.get_text())
            for word in page.get_text("words"):
                x0, y0, x1, y1, value, *_ = word
                words.append(
                    {
                        "page": page_index,
                        "x0": x0,
                        "y0": y0,
                        "x1": x1,
                        "text": value,
                    }
                )
        return "\n".join(chunks), doc.page_count, build_lines(words)


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


def main():
    pdf_path = Path(sys.argv[1])
    text, page_count, lines = extract_text(pdf_path)
    print(
        json.dumps(
            {
                "amount": extract_amount(text),
                "invoiceNo": extract_invoice_no(text, lines),
                "invoiceDate": extract_invoice_date(text, lines),
                "pageCount": page_count,
            }
        )
    )


if __name__ == "__main__":
    main()
