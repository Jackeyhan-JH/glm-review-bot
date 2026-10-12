/**
 * 高峰判断核心逻辑测试。所有时刻都用「+08:00」直接写北京墙上时间，
 * 避免依赖测试机的本地时区；断言一律给出 ISO 时刻便于定位失败点。
 *
 * 日期前提（测试内先断言，日期错了会先在这里炸）：
 * 2026-10-12 周一、10-16 周五、10-17 周六、10-18 周日、10-19 周一；2026-11-02 周一。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PEAK_DEFAULT_DISPLAY_TZ,
  canStartWork,
  currentWindow,
  deferUntil,
  isPeak,
  nextSwitch,
  peakWindows,
} from '../../src/peak/peak.ts';
import { PEAK_RULES } from '../../src/peak/rules.ts';

/** 北京墙上时间 → Date（北京 = UTC+8，写死偏移，与测试机 TZ 无关）。 */
function bj(wall: string): Date {
  return new Date(`${wall}+08:00`);
}

/** 周一 14:00 / 18:00（北京）的绝对时刻，便于断言区间端点。 */
const MON_OCT12_START = bj('2026-10-12T14:00:00').getTime();
const MON_OCT12_END = bj('2026-10-12T18:00:00').getTime();
/** 下周一（2026-10-19）14:00（北京）。 */
const NEXT_MON_START = bj('2026-10-19T14:00:00').getTime();

test('测试所用的星期前提成立（错了先改测试日期）', () => {
  const weekdayOf = (iso: string) => new Date(iso).getUTCDay();
  assert.equal(weekdayOf('2026-10-12T00:00:00Z'), 1); // 周一
  assert.equal(weekdayOf('2026-10-16T00:00:00Z'), 5); // 周五
  assert.equal(weekdayOf('2026-10-17T00:00:00Z'), 6); // 周六
  assert.equal(weekdayOf('2026-10-18T00:00:00Z'), 0); // 周日
  assert.equal(weekdayOf('2026-10-19T00:00:00Z'), 1); // 下周一
  assert.equal(weekdayOf('2026-11-02T00:00:00Z'), 1); // 周一（EST 周）
  assert.equal(PEAK_RULES.timeZone, 'Asia/Shanghai');
});

test('周一边界（北京时间）：13:59:59 非高峰，14:00:00 起高峰，17:59:59.999 仍高峰，18:00:00 出高峰', () => {
  // 13:59:59.999：还差 1ms 到高峰，下一次切换是今天 14:00（切入高峰）
  const before = bj('2026-10-12T13:59:59.999');
  assert.equal(isPeak(before), false, before.toISOString());
  const beforeSwitch = nextSwitch(before);
  assert.equal(beforeSwitch.at.getTime(), MON_OCT12_START);
  assert.equal(beforeSwitch.toPeak, true);
  assert.equal(currentWindow(before), null);

  // 14:00:00.000：区间左闭，算高峰；currentWindow 返回本段；下一次切换是 18:00（切出）
  const start = bj('2026-10-12T14:00:00');
  assert.equal(isPeak(start), true, start.toISOString());
  const startWindow = currentWindow(start);
  assert.ok(startWindow !== null);
  assert.equal(startWindow.start.getTime(), MON_OCT12_START);
  assert.equal(startWindow.end.getTime(), MON_OCT12_END);
  const startSwitch = nextSwitch(start);
  assert.equal(startSwitch.at.getTime(), MON_OCT12_END);
  assert.equal(startSwitch.toPeak, false);

  // 17:59:59.999：本段最后一毫秒仍是高峰
  const last = bj('2026-10-12T17:59:59.999');
  assert.equal(isPeak(last), true, last.toISOString());
  assert.equal(currentWindow(last)?.end.getTime(), MON_OCT12_END);
  assert.equal(nextSwitch(last).at.getTime(), MON_OCT12_END);

  // 18:00:00.000：区间右开，已不是高峰；下一次切换是明天 14:00
  const end = bj('2026-10-12T18:00:00');
  assert.equal(isPeak(end), false, end.toISOString());
  assert.equal(currentWindow(end), null);
  const endSwitch = nextSwitch(end);
  assert.equal(endSwitch.at.getTime(), bj('2026-10-13T14:00:00').getTime());
  assert.equal(endSwitch.toPeak, true);
});

test('工作日高峰前：周一 00:00 与 13:00 的下一次切换都是今天 14:00', () => {
  for (const wall of ['2026-10-12T00:00:00', '2026-10-12T07:30:00', '2026-10-12T13:00:00']) {
    const d = bj(wall);
    assert.equal(isPeak(d), false, wall);
    const sw = nextSwitch(d);
    assert.equal(sw.at.getTime(), MON_OCT12_START, wall);
    assert.equal(sw.toPeak, true, wall);
  }
});

test('周五 18:00 后的下一次切换是下周一 14:00（跳过周末）', () => {
  for (const wall of ['2026-10-16T18:00:00', '2026-10-16T19:23:45', '2026-10-16T23:59:59.999']) {
    const d = bj(wall);
    assert.equal(isPeak(d), false, wall);
    const sw = nextSwitch(d);
    assert.equal(sw.at.getTime(), NEXT_MON_START, wall);
    assert.equal(sw.toPeak, true, wall);
  }
});

test('周六、周日全天非高峰（逐小时扫描 + 边界时刻），下一次切换都是下周一 14:00', () => {
  const weekendDays = ['2026-10-17', '2026-10-18'];
  const moments: Date[] = [];
  for (const day of weekendDays) {
    for (let hour = 0; hour < 24; hour++) {
      moments.push(bj(`${day}T${String(hour).padStart(2, '0')}:30:00`));
    }
    // 周末里的「工作日高峰边界」时刻也一并验证
    for (const wall of ['T13:59:59.999', 'T14:00:00', 'T17:59:59.999', 'T18:00:00']) {
      moments.push(bj(day + wall));
    }
  }
  assert.ok(moments.length >= 56);
  for (const d of moments) {
    assert.equal(isPeak(d), false, d.toISOString());
    assert.equal(currentWindow(d), null, d.toISOString());
    assert.equal(deferUntil(d), null, d.toISOString());
    const sw = nextSwitch(d);
    assert.equal(sw.at.getTime(), NEXT_MON_START, d.toISOString());
    assert.equal(sw.toPeak, true, d.toISOString());
  }
});

test('与美东时间的对应（EDT=UTC-4 / EST=UTC-5）：高峰起止在美东是 02:00/06:00 与 01:00/05:00', () => {
  const nyHour = (d: Date) =>
    Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(d),
    );

  // 2026-10-12T06:00:00Z：北京周一 14:00，美东周一 02:00（EDT）——高峰开始
  const edtStart = new Date('2026-10-12T06:00:00Z');
  assert.equal(isPeak(edtStart), true);
  assert.equal(currentWindow(edtStart)?.start.getTime(), edtStart.getTime());
  assert.equal(nyHour(edtStart), 2);
  // 2026-10-12T10:00:00Z：北京 18:00，美东 06:00——高峰结束（右开，不算高峰）
  const edtEnd = new Date('2026-10-12T10:00:00Z');
  assert.equal(isPeak(edtEnd), false);
  assert.equal(nyHour(edtEnd), 6);

  // 2026-11-01 起美东进入冬令时（EST=UTC-5）：2026-11-02T06:00:00Z 是美东周一 01:00——高峰开始
  const estStart = new Date('2026-11-02T06:00:00Z');
  assert.equal(isPeak(estStart), true);
  assert.equal(currentWindow(estStart)?.start.getTime(), estStart.getTime());
  assert.equal(nyHour(estStart), 1);
  // 同一天 10:00Z：美东 05:00——高峰结束
  const estEnd = new Date('2026-11-02T10:00:00Z');
  assert.equal(isPeak(estEnd), false);
  assert.equal(nyHour(estEnd), 5);
});

test('deferUntil：高峰中返回本段结束时刻，非高峰返回 null', () => {
  // 高峰中（周一 15:00、14:00 整、17:59:59.999）
  for (const wall of ['2026-10-12T14:00:00', '2026-10-12T15:00:00', '2026-10-12T17:59:59.999']) {
    const d = bj(wall);
    assert.deepEqual(deferUntil(d), new Date(MON_OCT12_END), wall);
  }
  // 非高峰（周一上午、周一 18:00 整、周六中午）
  for (const wall of ['2026-10-12T09:00:00', '2026-10-12T18:00:00', '2026-10-17T12:00:00']) {
    const d = bj(wall);
    assert.equal(deferUntil(d), null, wall);
  }
  // deferUntil 与 currentWindow 一致：高峰时等于本段 end
  const inPeak = bj('2026-10-13T16:20:00');
  assert.equal(deferUntil(inPeak)?.getTime(), currentWindow(inPeak)?.end.getTime());
});

test('canStartWork：高峰中的任务直接推迟到本段结束', () => {
  // 周一 15:00（高峰中）预计 15 分钟
  const d = canStartWork(bj('2026-10-12T15:00:00'), 15);
  assert.equal(d.ok, false);
  assert.ok(d.waitUntil instanceof Date);
  assert.equal(d.waitUntil?.getTime(), MON_OCT12_END);
});

test('canStartWork：高峰前 10 分钟、预计 15 分钟的任务会跑进高峰，应推迟', () => {
  // 周一 13:50 + 15 分钟 = 14:05，跨进本段高峰 → 推迟到 18:00
  const deferred = canStartWork(bj('2026-10-12T13:50:00'), 15);
  assert.equal(deferred.ok, false);
  assert.equal(deferred.waitUntil?.getTime(), MON_OCT12_END);

  // 同一时刻只预计 10 分钟：恰好在 14:00:00 收尾，不算跨进高峰（左闭右开），可启动
  const fits = canStartWork(bj('2026-10-12T13:50:00'), 10);
  assert.deepEqual(fits, { ok: true });

  // 预计 11 分钟：14:01 收尾，跨进高峰
  const spills = canStartWork(bj('2026-10-12T13:50:00'), 11);
  assert.equal(spills.ok, false);
  assert.equal(spills.waitUntil?.getTime(), MON_OCT12_END);
});

test('canStartWork：非高峰启动没有重叠风险时放行', () => {
  // 周一 19:00 预计 1 小时：离明天 14:00 还很远
  assert.deepEqual(canStartWork(bj('2026-10-12T19:00:00'), 60), { ok: true });
  // 周一凌晨长任务 13 小时：13:00 收尾，恰好赶在 14:00 前
  assert.deepEqual(canStartWork(bj('2026-10-12T00:00:00'), 13 * 60), { ok: true });
  // 周六中午随便跑
  assert.deepEqual(canStartWork(bj('2026-10-17T12:00:00'), 120), { ok: true });
  // 周日 23:00 预计 2 小时：跨进周一 14:00 前不算，但 23:00+120min=周一 01:00，仍非高峰
  assert.deepEqual(canStartWork(bj('2026-10-18T23:00:00'), 120), { ok: true });
});

test('canStartWork：跨夜/跨周末撞上下一段高峰也要推迟', () => {
  // 周日 23:00 预计 16 小时：周一 15:00 收尾，跨进下周一高峰 → 推迟到周一 18:00
  const cross = canStartWork(bj('2026-10-18T23:00:00'), 16 * 60);
  assert.equal(cross.ok, false);
  assert.equal(cross.waitUntil?.getTime(), NEXT_MON_START + 4 * 3_600_000);

  // 周五 13:00 预计 75 分钟：14:15 收尾，跨进当天高峰
  const fri = canStartWork(bj('2026-10-16T13:00:00'), 75);
  assert.equal(fri.ok, false);
  assert.equal(fri.waitUntil?.getTime(), bj('2026-10-16T18:00:00').getTime());
  // 周五 13:00 恰好预计 60 分钟：14:00 收尾，放行
  assert.deepEqual(canStartWork(bj('2026-10-16T13:00:00'), 60), { ok: true });
});

test('canStartWork：预计耗时非法（负数/小数）按 0 分钟处理，不抛异常', () => {
  assert.deepEqual(canStartWork(bj('2026-10-12T19:00:00'), -5), { ok: true });
  assert.deepEqual(canStartWork(bj('2026-10-12T19:00:00'), 2.9), { ok: true });
  // 非高峰起点 + 0 分钟没有可重叠的高峰区间
  assert.deepEqual(canStartWork(bj('2026-10-12T19:00:00'), 0), { ok: true });
});

test('peakWindows：一整周恰好 5 段，每段 4 小时、端点正确', () => {
  const week = peakWindows(bj('2026-10-12T00:00:00'), bj('2026-10-19T00:00:00'));
  assert.equal(week.length, 5);
  for (let i = 0; i < 5; i++) {
    const day = 12 + i; // 10-12（周一）… 10-16（周五）
    assert.equal(week[i]?.start.getTime(), bj(`2026-10-${String(day).padStart(2, '0')}T14:00:00`).getTime());
    assert.equal(week[i]?.end.getTime(), bj(`2026-10-${String(day).padStart(2, '0')}T18:00:00`).getTime());
    assert.equal(week[i]!.end.getTime() - week[i]!.start.getTime(), 4 * 3_600_000);
  }
  // 只查周末：空数组
  assert.deepEqual(peakWindows(bj('2026-10-17T00:00:00'), bj('2026-10-19T00:00:00')), []);
  // 空范围 / 逆序范围：空数组
  assert.deepEqual(peakWindows(bj('2026-10-13T00:00:00'), bj('2026-10-13T00:00:00')), []);
  assert.deepEqual(peakWindows(bj('2026-10-13T01:00:00'), bj('2026-10-13T00:00:00')), []);
  // 高峰内的子区间：返回整段，不裁剪
  const inside = peakWindows(bj('2026-10-12T15:00:00'), bj('2026-10-12T16:00:00'));
  assert.equal(inside.length, 1);
  assert.equal(inside[0]?.start.getTime(), MON_OCT12_START);
  assert.equal(inside[0]?.end.getTime(), MON_OCT12_END);
});

test('各纯函数不改动传入的 Date', () => {
  const d = bj('2026-10-12T15:00:00');
  const ts = d.getTime();
  isPeak(d);
  currentWindow(d);
  nextSwitch(d);
  deferUntil(d);
  canStartWork(d, 30);
  peakWindows(d, new Date(ts + 3_600_000));
  assert.equal(d.getTime(), ts);
  assert.equal(d.toISOString(), '2026-10-12T07:00:00.000Z');
});

test('PEAK_DEFAULT_DISPLAY_TZ 默认展示时区是美东', () => {
  assert.equal(PEAK_DEFAULT_DISPLAY_TZ, 'America/New_York');
});

/* ------------------------------------------------------------------------- */
/* 与 glm-peak-clock（commit 6b2b937 的 src/peak.js）固定偏移算法逐点对照。     */
/* 该算法只用 tzOffsetMinutes=480 做算术、完全不经过 Intl，是独立的参照实现。   */
/* ------------------------------------------------------------------------- */

const REF = {
  tzOffsetMinutes: 480,
  peakDays: [1, 2, 3, 4, 5],
  peakStartMinutes: 840,
  peakEndMinutes: 1080,
};

/** 参照实现：固定偏移拆北京日（与 glm-peak-clock 的 beijingParts 相同）。 */
function refParts(ts: number) {
  const shifted = new Date(ts + REF.tzOffsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    msOfDay:
      ((shifted.getUTCHours() * 60 + shifted.getUTCMinutes()) * 60 + shifted.getUTCSeconds()) * 1000 +
      shifted.getUTCMilliseconds(),
  };
}

/** 参照实现：某北京日的高峰区间（绝对毫秒）。 */
function refWindow(year: number, month: number, day: number) {
  const dayStartUtcMs = Date.UTC(year, month, day) - REF.tzOffsetMinutes * 60_000;
  return {
    start: dayStartUtcMs + REF.peakStartMinutes * 60_000,
    end: dayStartUtcMs + REF.peakEndMinutes * 60_000,
  };
}

function refIsPeak(ts: number): boolean {
  const { weekday, msOfDay } = refParts(ts);
  return (
    REF.peakDays.includes(weekday) &&
    msOfDay >= REF.peakStartMinutes * 60_000 &&
    msOfDay < REF.peakEndMinutes * 60_000
  );
}

/** 参照实现：下一次翻转的绝对毫秒（与 glm-peak-clock 的 getStatus 相同的分枝）。 */
function refNextSwitchTs(ts: number): number {
  const { year, month, day, weekday, msOfDay } = refParts(ts);
  const today = refWindow(year, month, day);
  const startMs = REF.peakStartMinutes * 60_000;
  const endMs = REF.peakEndMinutes * 60_000;
  if (REF.peakDays.includes(weekday) && msOfDay >= startMs && msOfDay < endMs) return today.end;
  if (REF.peakDays.includes(weekday) && msOfDay < startMs) return today.start;
  for (let offset = 1; offset <= 8; offset++) {
    const d = new Date(Date.UTC(year, month, day + offset));
    if (REF.peakDays.includes(d.getUTCDay())) {
      return refWindow(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).start;
    }
  }
  throw new Error('参照实现不应走到这里');
}

/** 断言本项目实现与参照实现在某时刻完全一致（peak、本段区间、下一次翻转时刻与方向）。 */
function assertMatchesRef(ts: number): void {
  const d = new Date(ts);
  const iso = d.toISOString();
  assert.equal(isPeak(d), refIsPeak(ts), `isPeak @ ${iso}`);
  const sw = nextSwitch(d);
  assert.equal(sw.at.getTime(), refNextSwitchTs(ts), `nextSwitch @ ${iso}`);
  assert.equal(sw.toPeak, !refIsPeak(ts), `toPeak @ ${iso}`);
  assert.ok(sw.at.getTime() > ts, `切换时刻必须严格在未来 @ ${iso}`);
  // currentWindow / deferUntil 与参照区间一致：高峰中为本段区间/其结束时刻，否则 null
  if (refIsPeak(ts)) {
    const { year, month, day } = refParts(ts);
    const expect = refWindow(year, month, day);
    assert.equal(currentWindow(d)?.start.getTime(), expect.start, `currentWindow.start @ ${iso}`);
    assert.equal(currentWindow(d)?.end.getTime(), expect.end, `currentWindow.end @ ${iso}`);
    assert.equal(deferUntil(d)?.getTime(), expect.end, `deferUntil @ ${iso}`);
  } else {
    assert.equal(currentWindow(d), null, `currentWindow @ ${iso}`);
    assert.equal(deferUntil(d), null, `deferUntil @ ${iso}`);
  }
}

test('与 glm-peak-clock 参照实现一致：两周内每 30 分钟逐点对照', () => {
  const base = Date.UTC(2026, 9, 8); // 2026-10-08（周四）起
  for (let ts = base; ts < base + 14 * 24 * 3_600_000; ts += 30 * 60_000) {
    assertMatchesRef(ts);
  }
});

test('与 glm-peak-clock 参照实现一致：切换边界前后每 250ms 逐点对照', () => {
  const edges = [
    Date.UTC(2026, 9, 12, 6, 0, 0), // 周一 14:00 北京（高峰开始）
    Date.UTC(2026, 9, 12, 10, 0, 0), // 周一 18:00 北京（高峰结束）
    Date.UTC(2026, 9, 16, 6, 0, 0), // 周五 14:00 北京
    Date.UTC(2026, 9, 18, 16, 0, 0), // 周日 24:00 北京（切到下周一的关键点）
  ];
  for (const edge of edges) {
    for (let ts = edge - 2_000; ts <= edge + 2_000; ts += 250) {
      assertMatchesRef(ts);
    }
  }
});

test('与 glm-peak-clock 参照实现一致：跨夏令时切换周（2026-10-25 欧洲 / 11-01 美东）', () => {
  const base = Date.UTC(2026, 9, 30);
  for (let ts = base; ts < base + 7 * 24 * 3_600_000; ts += 15 * 60_000) {
    assertMatchesRef(ts);
  }
});

test('与 glm-peak-clock 参照实现一致：2026–2027 两年内确定性随机抽样 2000 个时刻', () => {
  let seed = 20261012;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  const base = Date.UTC(2026, 0, 1);
  const span = Date.UTC(2028, 0, 1) - base;
  for (let i = 0; i < 2000; i++) {
    assertMatchesRef(base + Math.floor((rand() / 2147483648) * span));
  }
});
