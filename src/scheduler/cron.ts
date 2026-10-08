/**
 * 极简 5 字段 Cron（分 时 日 月 周）解析与 nextAfter 计算。
 * 只服务于「库存水位周期巡检」的调度演示，支持通配符、步进写法、逗号列表、区间。
 */
export type CronFields = {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
};

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) out.add(i);
    } else if (part.includes('/')) {
      const [base, stepStr] = part.split('/');
      const step = Number(stepStr);
      const range = base === '*' ? [min, max] : [Number(base), max];
      for (let i = range[0]; i <= range[1]; i += step) out.add(i);
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      out.add(Number(part));
    }
  }
  return out;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 表达式需 5 字段，收到：${expr}`);
  }
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dom: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dow: parseField(parts[4], 0, 6)
  };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function matches(fields: CronFields, date: Date): boolean {
  const dow = date.getUTCDay();
  return (
    fields.minute.has(date.getUTCMinutes()) &&
    fields.hour.has(date.getUTCHours()) &&
    fields.dom.has(date.getUTCDate()) &&
    fields.month.has(date.getUTCMonth() + 1) &&
    fields.dow.has(dow)
  );
}

/**
 * 计算 from 之后（不含 from 自身）的下一次触发时间。
 * 逐分钟推进，上限 366 天（避免死循环）。
 */
export function nextAfter(expr: string, from: Date): Date {
  const fields = parseCron(expr);
  const cur = new Date(from.getTime());
  cur.setUTCSeconds(0, 0);
  cur.setUTCMinutes(cur.getUTCMinutes() + 1);
  const limit = from.getTime() + 366 * 24 * 3600 * 1000;
  while (cur.getTime() <= limit) {
    if (matches(fields, cur)) return new Date(cur.getTime());
    cur.setUTCMinutes(cur.getUTCMinutes() + 1);
  }
  throw new Error(`cron 表达式 ${expr} 在 366 天内无下一次触发`);
}

export function formatIso(date: Date): string {
  return date.toISOString();
}
