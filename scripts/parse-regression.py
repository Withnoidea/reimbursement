# -*- coding: utf-8 -*-
"""发票解析回归用例：改动 tools/parse_pdf.py 或 src/pdfParser.js 后运行
用法：.venv\\Scripts\\python.exe scripts\\parse-regression.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "tools"))
from parse_pdf import extract_amount, extract_invoice_date, extract_invoice_no

CASES = [
    # (说明, 文本, 期望金额)
    ("增值税发票-小写标记", "价税合计（大写）壹拾伍元肆角捌分（小写）￥15.48\n开票日期：2026年07月09日\n发票号码：25617000000123456789", 15.48),
    ("增值税发票-仅¥符号", "金 额 ¥13.70\n税 额 ¥1.78\n¥15.48\n开票日期：2026年07月09日", 15.48),
    ("行程单-合计X元", "申请时间：2026.07.09\n行程时间：2026.07.09 - 2026.07.09\n共1笔行程，合计15.48元\n用车里程\n(公里)\n金额\n(元)\n10.2\n15.48\n制作时间：2026-07-09 14:46:56", 15.48),
    ("账单-实付金额标签", "订单编号 20260709123456\n实付金额 128.00\n支付时间 2026.07.09", 128.00),
    ("无标签-裸小数与日期混排", "服务时间 2026.07.09 12:40\n费用 128.50 元外加说明", 128.50),
    ("仅年月-应放弃识别", "对账单 账期 2026.07", None),
    ("裸小数-恰好像年份但小数>12", "押金 2026.48", 2026.48),
    ("日期不干扰裸小数", "2026.07.09 打印\n88.00", 88.00),
]

failures = []
for name, text, expected in CASES:
    got = extract_amount(text)
    status = "OK  " if got == expected else "FAIL"
    if got != expected:
        failures.append(name)
    print(f"{status} {name}: got={got} expected={expected}")

# 日期与发票号抽查
d1 = extract_invoice_date("开票日期：2026年07月09日")
d2 = extract_invoice_date("申请时间：2026.07.09\n共1笔行程，合计15.48元")
d3 = extract_invoice_date("制作时间：2026-07-09 14:46:56")
n1 = extract_invoice_no("发票号码：25617000000123456789")
print(f"{'OK  ' if d1 == '2026-07-09' else 'FAIL'} 日期-开票日期标签: {d1}")
print(f"{'OK  ' if d2 == '2026-07-09' else 'FAIL'} 日期-数字格式兜底: {d2}")
print(f"{'OK  ' if d3 == '2026-07-09' else 'FAIL'} 日期-横线格式兜底: {d3}")
print(f"{'OK  ' if n1 == '25617000000123456789' else 'FAIL'} 发票号: {n1}")
if d1 != "2026-07-09": failures.append("日期-标签")
if d2 != "2026-07-09": failures.append("日期-数字兜底")
if d3 != "2026-07-09": failures.append("日期-横线兜底")
if n1 != "25617000000123456789": failures.append("发票号")

print("RESULT:", "PASSED" if not failures else f"FAILED: {failures}")
sys.exit(0 if not failures else 1)
