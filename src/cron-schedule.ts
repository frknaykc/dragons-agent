const MINUTE = 60_000;
const SEARCH_LIMIT_MINUTES = 4 * 366 * 24 * 60;

type CronField = ReadonlySet<number>;

export type CronSchedule = {
  minutes: CronField;
  hours: CronField;
  daysOfMonth: CronField;
  months: CronField;
  daysOfWeek: CronField;
  everyDayOfMonth: boolean;
  everyDayOfWeek: boolean;
};

function parseField(text: string, lower: number, upper: number): { values: CronField; wildcard: boolean } {
  const values = new Set<number>();
  const wildcard = text === "*";
  for (const part of text.split(",")) {
    const match = /^(\*|\d{1,2})(?:-(\d{1,2}))?(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) throw new Error("Invalid cron field.");
    const start = match[1] === "*" ? lower : Number(match[1]);
    const end = match[2] === undefined ? (match[1] === "*" ? upper : start) : Number(match[2]);
    const step = match[3] === undefined ? 1 : Number(match[3]);
    if (start < lower || end > upper || end < start || step < 1 || step > upper - lower + 1 || (match[3] !== undefined && match[1] !== "*" && match[2] === undefined)) {
      throw new Error("Invalid cron field range or step.");
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { values, wildcard };
}

/** Five-field UTC cron syntax: minute hour day-of-month month day-of-week. */
export function parseCronSchedule(expression: string): CronSchedule {
  if (typeof expression !== "string" || expression.length > 120) throw new Error("Invalid cron expression.");
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron expression requires five fields.");
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = [
    parseField(fields[0], 0, 59), parseField(fields[1], 0, 23), parseField(fields[2], 1, 31),
    parseField(fields[3], 1, 12), parseField(fields[4], 0, 6),
  ];
  return {
    minutes: minutes.values, hours: hours.values, daysOfMonth: daysOfMonth.values,
    months: months.values, daysOfWeek: daysOfWeek.values,
    everyDayOfMonth: daysOfMonth.wildcard, everyDayOfWeek: daysOfWeek.wildcard,
  };
}

/** Returns the next UTC minute strictly after `after`, searching across the leap-year cycle. */
export function nextCronOccurrence(expression: string, after: Date): Date {
  const schedule = parseCronSchedule(expression);
  const epoch = after instanceof Date ? after.getTime() : NaN;
  if (!Number.isFinite(epoch)) throw new Error("Invalid cron reference time.");
  let minute = Math.floor(epoch / MINUTE) + 1;
  for (let offset = 0; offset < SEARCH_LIMIT_MINUTES; offset += 1, minute += 1) {
    const date = new Date(minute * MINUTE);
    const dayOfMonth = schedule.daysOfMonth.has(date.getUTCDate());
    const dayOfWeek = schedule.daysOfWeek.has(date.getUTCDay());
    const dayMatches = schedule.everyDayOfMonth ? dayOfWeek : schedule.everyDayOfWeek ? dayOfMonth : dayOfMonth || dayOfWeek;
    if (schedule.months.has(date.getUTCMonth() + 1) && dayMatches
      && schedule.hours.has(date.getUTCHours()) && schedule.minutes.has(date.getUTCMinutes())) return date;
  }
  throw new Error("Cron expression has no occurrence within four years.");
}
