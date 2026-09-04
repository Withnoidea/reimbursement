export const DEFAULT_REIMBURSEMENT_STATUS = "collecting";

export const REIMBURSEMENT_STATUSES = [
  {
    value: "collecting",
    label: "整理中",
    description: "仍在收集或核对单据",
  },
  {
    value: "submitted",
    label: "报销中",
    description: "已提交，等待审批或打款",
  },
  {
    value: "received",
    label: "已到账",
    description: "报销款已收到并计入到账统计",
  },
];

const STATUS_MAP = new Map(REIMBURSEMENT_STATUSES.map((item) => [item.value, item]));

export function normalizeReimbursementStatus(value) {
  return STATUS_MAP.has(value) ? value : DEFAULT_REIMBURSEMENT_STATUS;
}

export function getReimbursementStatusMeta(value) {
  return STATUS_MAP.get(normalizeReimbursementStatus(value));
}

export function isReimbursementReceived(item) {
  return normalizeReimbursementStatus(item?.status) === "received";
}

export function todayDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
